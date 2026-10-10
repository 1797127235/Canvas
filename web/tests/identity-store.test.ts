import { afterEach, beforeEach, expect, test } from "bun:test";

import { IdentityApiError } from "../src/services/api/identity";
import { useUserStore } from "../src/stores/use-user-store";

const originalFetch = globalThis.fetch;

beforeEach(() => {
    useUserStore.setState({ status: "loading", user: null, expiresAt: null, error: null });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test("treats an unauthenticated session response as guest", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "请先登录" } }), { status: 401 });
    await useUserStore.getState().refreshSession();
    expect(useUserStore.getState().status).toBe("guest");
    expect(useUserStore.getState().user).toBeNull();
});

test("preserves a network failure as an error state", async () => {
    globalThis.fetch = async () => {
        throw new Error("offline");
    };
    await useUserStore.getState().refreshSession();
    expect(useUserStore.getState().status).toBe("error");
    expect(useUserStore.getState().error?.message).toBe("offline");
});

test("stores the session returned after registration", async () => {
    globalThis.fetch = async () =>
        new Response(JSON.stringify({ user: { id: "user-1", email: "person@example.com" }, expiresAt: "2026-10-16T00:00:00.000Z" }), { status: 201 });
    await useUserStore.getState().register({ email: "person@example.com", password: "Correct!Password123" });
    expect(useUserStore.getState().status).toBe("authenticated");
    expect(useUserStore.getState().user?.id).toBe("user-1");
});

test("clears the session after logout", async () => {
    useUserStore.setState({ status: "authenticated", user: { id: "user-1", email: "person@example.com" }, expiresAt: "2026-10-16T00:00:00.000Z", error: null });
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await useUserStore.getState().logout();
    expect(useUserStore.getState().status).toBe("guest");
    expect(useUserStore.getState().user).toBeNull();
});

test("does not restore a session from a refresh started before logout", async () => {
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
    const refresh = useUserStore.getState().refreshSession();
    globalThis.fetch = async () => new Response(null, { status: 204 });
    await useUserStore.getState().logout();
    finish(new Response(JSON.stringify({ user: { id: "old-user", email: "old@example.com" }, expiresAt: "2099-01-01T00:00:00.000Z" })));
    await refresh;
    expect(useUserStore.getState().status).toBe("guest");
    expect(useUserStore.getState().user).toBeNull();
});

test("does not let an earlier guest refresh overwrite a completed login", async () => {
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
    const refresh = useUserStore.getState().refreshSession();
    globalThis.fetch = async () => new Response(JSON.stringify({ user: { id: "new-user", email: "new@example.com" }, expiresAt: "2099-01-01T00:00:00.000Z" }), { status: 201 });
    await useUserStore.getState().login({ email: "new@example.com", password: "Correct!Password123" });
    finish(new Response(JSON.stringify({ error: { code: "UNAUTHENTICATED", message: "请先登录" } }), { status: 401 }));
    await refresh;
    expect(useUserStore.getState().status).toBe("authenticated");
    expect(useUserStore.getState().user?.id).toBe("new-user");
});

test("preserves the current session when logout fails", async () => {
    useUserStore.setState({ status: "authenticated", user: { id: "user-1", email: "person@example.com" }, error: null });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } }), { status: 500 });
    await expect(useUserStore.getState().logout()).rejects.toBeInstanceOf(IdentityApiError);
    expect(useUserStore.getState().status).toBe("authenticated");
});

test("keeps structured API failures available to callers", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "LOGIN_LOCKED", message: "登录暂时受限，请稍后重试" } }), { status: 429 });
    await expect(useUserStore.getState().login({ email: "person@example.com", password: "Correct!Password123" })).rejects.toBeInstanceOf(IdentityApiError);
});
