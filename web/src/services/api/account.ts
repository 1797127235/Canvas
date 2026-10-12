import { useUserStore } from "@/stores/use-user-store";

export type CredentialStatus = { configured: boolean; masked: string | null };

export async function getCredential() {
    const response = await fetch("/api/credentials", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("账号配置读取失败");
    return (await response.json()) as CredentialStatus;
}

export async function saveCredential(apiKey: string) {
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error("请先登录");
    const response = await fetch("/api/credentials", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Account-Id": userId, Accept: "application/json" }, body: JSON.stringify({ apiKey }) });
    if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换");
    if (!response.ok) throw new Error("API Key 保存失败");
}

export async function clearCredential() {
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error("请先登录");
    const response = await fetch("/api/credentials", { method: "DELETE", credentials: "same-origin", headers: { "X-Account-Id": userId, Accept: "application/json" } });
    if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换");
    if (!response.ok) throw new Error("API Key 清除失败");
}
