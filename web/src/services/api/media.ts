import i18n from "@/i18n";
import { useUserStore } from "@/stores/use-user-store";

async function withAccountMedia<T>(signal: AbortSignal | undefined, request: (signal: AbortSignal, userId: string) => Promise<T>) {
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error("请先登录");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    const unsubscribe = useUserStore.subscribe((state) => {
        if (state.user?.id !== userId) controller.abort(new Error("账号已切换，请重试"));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
        controller.signal.throwIfAborted();
        const result = await request(controller.signal, userId);
        controller.signal.throwIfAborted();
        if (useUserStore.getState().user?.id !== userId) throw new Error("账号已切换，请重试");
        return result;
    } finally {
        unsubscribe();
        signal?.removeEventListener("abort", abort);
    }
}

export async function uploadAccountMedia(blob: Blob, options?: { signal?: AbortSignal }) {
    return withAccountMedia(options?.signal, async (signal, userId) => {
        const response = await fetch("/api/media", { method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type || "application/octet-stream", "X-Account-Id": userId, Accept: "application/json" }, body: blob, signal });
        if (!response.ok) throw new Error("媒体上传失败");
        const result = (await response.json()) as { id: string; mimeType: string; bytes: number };
        return { storageKey: `remote:${result.id}`, url: `/api/media/${result.id}`, mimeType: result.mimeType, bytes: result.bytes };
    });
}

export async function fetchAccountMedia(storageKey: string, options?: { signal?: AbortSignal }) {
    const id = storageKey.startsWith("remote:") ? storageKey.slice("remote:".length) : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("媒体标识无效");
    // 保留账号媒体导出原有的 XHR 读取方式，图片与音视频共用。
    return withAccountMedia(options?.signal, (signal, userId) => new Promise<Blob>((resolve, reject) => {
        const request = new XMLHttpRequest();
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => request.abort();
        request.open("GET", `/api/media/${encodeURIComponent(id)}`);
        request.setRequestHeader("X-Account-Id", userId);
        request.responseType = "blob";
        request.onload = () => {
            cleanup();
            if (request.status >= 200 && request.status < 300) resolve(request.response);
            else reject(new Error("媒体读取失败"));
        };
        request.onerror = () => { cleanup(); reject(new Error("媒体读取失败")); };
        request.onabort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
        signal.addEventListener("abort", abort, { once: true });
        try {
            signal.throwIfAborted();
            request.send();
        } catch (error) {
            cleanup();
            reject(error);
        }
    }));
}

// 生成请求的参考素材只传身份（remote:<uuid>），字节由服务端从账号媒体读取。
// 账号模式下素材在上传时就已得到 remote: 身份；缺失说明上传未完成，直接报错而不是静默丢素材。
export function requireAccountMediaRefs(items: readonly { storageKey?: string }[]) {
    return items.map((item) => {
        if (!item.storageKey?.startsWith("remote:")) throw new Error(i18n.t("apiErrors.referenceMediaNotUploaded"));
        return item.storageKey;
    });
}

export function accountMediaUrl(storageKey?: string) {
    return storageKey?.startsWith("remote:") ? `/api/media/${storageKey.slice("remote:".length)}` : "";
}

export function accountMediaPreviewUrl(storageKey?: string, requiredLongEdge?: number) {
    if (!storageKey?.startsWith("remote:")) return "";
    const id = storageKey.slice("remote:".length);
    // 只报「需要显示的最长边」，具体挑哪一档由服务端决定，避免档位表在两端各存一份。
    const edge = requiredLongEdge && Number.isFinite(requiredLongEdge) && requiredLongEdge > 0 ? requiredLongEdge : 0;
    return edge ? `/api/media/${id}/preview?w=${Math.ceil(edge)}` : `/api/media/${id}/preview`;
}

export function accountMediaPosterUrl(storageKey?: string) {
    return storageKey?.startsWith("remote:") ? `/api/media/${storageKey.slice("remote:".length)}/poster` : "";
}
