// 本地开发默认使用真实账号；仅显式开启时使用旧本地工作区。
export const bypassLocalAuth = import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS === "true";

export function canAccessLocalFeatures(status: string) {
    return bypassLocalAuth || status === "authenticated";
}
