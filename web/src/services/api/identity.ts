export type AuthInput = {
    email: string;
    password: string;
};

export type CurrentUser = {
    id: string;
    email: string;
};

export type SessionResponse = {
    user: CurrentUser;
    expiresAt: string;
};

export type ApiError = {
    error: {
        code: string;
        message: string;
    };
};

export class IdentityApiError extends Error {
    status: number;
    code: string;

    constructor(status: number, payload: ApiError | null) {
        super(payload?.error.message || "身份服务暂时不可用");
        this.name = "IdentityApiError";
        this.status = status;
        this.code = payload?.error.code || "INTERNAL_ERROR";
    }
}

export async function register(input: AuthInput) {
    return request<SessionResponse>("/api/users", { method: "POST", body: JSON.stringify(input) });
}

export async function login(input: AuthInput) {
    return request<SessionResponse>("/api/sessions", { method: "POST", body: JSON.stringify(input) });
}

export async function getSession() {
    return request<SessionResponse>("/api/session");
}

export async function logout() {
    const response = await fetch("/api/session", { method: "DELETE", credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok && response.status !== 204) throw await toError(response);
}

async function request<T>(url: string, init: RequestInit = {}) {
    const response = await fetch(url, {
        ...init,
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...init.headers },
    });
    if (!response.ok) throw await toError(response);
    return (await response.json()) as T;
}

async function toError(response: Response) {
    let payload: ApiError | null = null;
    try {
        payload = (await response.json()) as ApiError;
    } catch {
        // Preserve the HTTP status when the server did not return JSON.
    }
    return new IdentityApiError(response.status, payload);
}
