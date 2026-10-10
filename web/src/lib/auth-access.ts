// 本地开发默认免登录；身份联调时可在 .env.local 中设置 VITE_AUTH_BYPASS=false。
export const bypassLocalAuth = import.meta.env.DEV && import.meta.env.VITE_AUTH_BYPASS !== "false";

export function canAccessLocalFeatures(status: string) {
    return bypassLocalAuth || status === "authenticated";
}
