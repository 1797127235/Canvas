import { useUserStore } from "@/stores/use-user-store";

export type CredentialStatus = { configured: boolean; masked: string | null; baseUrl: string | null };

export async function getCredential() {
    const response = await fetch("/api/credentials", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("账号配置读取失败");
    return (await response.json()) as CredentialStatus;
}

export async function saveCredential(apiKey: string) {
    await putCredential({ apiKey }, "API Key 保存失败");
}

// 空串表示清掉账号地址，回落到部署目录里的默认上游。
export async function saveBaseUrl(baseUrl: string) {
    await putCredential({ baseUrl }, "上游地址保存失败");
}

async function putCredential(body: Record<string, string>, fallback: string) {
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error("请先登录");
    const response = await fetch("/api/credentials", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Account-Id": userId, Accept: "application/json" }, body: JSON.stringify(body) });
    if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换");
    if (!response.ok) throw new Error(await errorMessage(response, fallback));
}

// 服务端会给出「地址无效」这类具体原因，能拿到就优先展示。
async function errorMessage(response: Response, fallback: string) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return payload?.error?.message || fallback;
}

export async function clearCredential() {
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error("请先登录");
    const response = await fetch("/api/credentials", { method: "DELETE", credentials: "same-origin", headers: { "X-Account-Id": userId, Accept: "application/json" } });
    if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换");
    if (!response.ok) throw new Error("API Key 清除失败");
}
