export async function uploadAccountMedia(blob: Blob) {
    const response = await fetch("/api/media", { method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type || "application/octet-stream", Accept: "application/json" }, body: blob });
    if (!response.ok) throw new Error("媒体上传失败");
    const result = (await response.json()) as { id: string; mimeType: string; bytes: number };
    return { storageKey: `remote:${result.id}`, url: `/api/media/${result.id}`, mimeType: result.mimeType, bytes: result.bytes };
}

export function accountMediaUrl(storageKey?: string) {
    return storageKey?.startsWith("remote:") ? `/api/media/${storageKey.slice("remote:".length)}` : "";
}
