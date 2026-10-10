export const DEFAULT_AUTH_REDIRECT = "/";

export function getSafeAuthRedirect(value: string | null | undefined, origin = typeof window === "undefined" ? "http://localhost" : window.location.origin) {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_AUTH_REDIRECT;
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin) return DEFAULT_AUTH_REDIRECT;
        return `${url.pathname}${url.search}${url.hash}`;
    } catch {
        return DEFAULT_AUTH_REDIRECT;
    }
}

export function createAuthRedirect(pathname: string) {
    const safePath = getSafeAuthRedirect(pathname);
    return safePath === DEFAULT_AUTH_REDIRECT ? "/" : safePath;
}
