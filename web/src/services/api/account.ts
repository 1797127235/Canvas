export type CredentialStatus = { configured: boolean; masked: string | null };

export async function getCredential() {
    const response = await fetch("/api/credentials", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("账号配置读取失败");
    return (await response.json()) as CredentialStatus;
}

export async function saveCredential(apiKey: string) {
    const response = await fetch("/api/credentials", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ apiKey }) });
    if (!response.ok) throw new Error("API Key 保存失败");
}

export async function clearCredential() {
    const response = await fetch("/api/credentials", { method: "DELETE", credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("API Key 清除失败");
}
