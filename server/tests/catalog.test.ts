import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import express from "express";
import type { Pool } from "pg";

import { createCatalogRouter } from "../src/catalog/router.js";
import { accountModels, loadCatalog, publicModels, resolveModel } from "../src/catalog/catalog.js";
import { encryptCredential } from "../src/credential-crypto.js";
import { gateway } from "../src/gateway/index.js";
import { registerTestProvider } from "./support/test-provider.js";

registerTestProvider(gateway);
import { hashSid } from "../src/identity/session.js";
import { startTestServer } from "./support/http.js";

const directory = await mkdtemp(join(tmpdir(), "catalog-test-"));
const write = async (name: string, content: unknown) => {
    const path = join(directory, name);
    if (typeof content === "object" && content && "models" in content && Array.isArray(content.models)) Object.assign(content, { discoveryProviderId: "test-provider" });
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
};
const model = (overrides: Record<string, unknown> = {}) => ({
    id: "image", name: "Image", upstreamModel: "gpt-image-2.5", providerId: "test-provider",
    capability: "image", enabled: true, baseUrl: "https://api.example.com/v1", ...overrides,
});

after(() => rm(directory, { recursive: true, force: true }));

test("returns an empty catalog when no path is configured", async () => {
    assert.deepEqual(await loadCatalog(), { models: [] });
});

test("trims surrounding whitespace from base URLs and rejects embedded keys", async () => {
    const path = await write("trim.json", { discoveryProviderId: "test-provider", models: [model({ baseUrl: "  https://api.example.com/v1  " })] });
    const catalog = await loadCatalog(path);
    assert.equal(catalog.models[0].baseUrl, "https://api.example.com/v1");
    await assert.rejects(loadCatalog(await write("keyed.json", { models: [model({ apiKey: "key" })] })), /Invalid catalog configuration/);
});

test("rejects a providerId that is not registered", async () => {
    const path = await write("mismatch.json", { discoveryProviderId: "test-provider", models: [model({ providerId: "unknown-provider" })] });
    await assert.rejects(loadCatalog(path), /Invalid catalog configuration/);
});

test("rejects duplicate ids, unknown fields, unregistered providers and malformed JSON", async () => {
    const cases = [
        { discoveryProviderId: "test-provider", models: [model(), model({ name: "Other" })] },
        { discoveryProviderId: "test-provider", models: [model({ script: "x" })] },
        { discoveryProviderId: "test-provider", models: [model({ providerId: "custom" })] },
        { discoveryProviderId: "test-provider", models: [model({ providerId: "unknown-provider", capability: "video" })] },
        { upstream: { baseUrl: "https://api.example.com/v1" }, models: [] },
    ];
    for (const [index, content] of cases.entries()) {
        await assert.rejects(loadCatalog(await write(`invalid-${index}.json`, content)), /Invalid catalog configuration/);
    }
    await assert.rejects(loadCatalog(await write("broken.json", "{ not json")), /Invalid catalog configuration/);
});

test("allows HTTP and HTTPS upstreams in production", async () => {
    const path = await write("http.json", { discoveryProviderId: "test-provider", models: [model({ baseUrl: "http://127.0.0.1:8000/v1" })] });
    assert.equal((await loadCatalog(path, true)).models.length, 1);
    await assert.rejects(loadCatalog(await write("ftp.json", { discoveryProviderId: "test-provider", models: [model({ baseUrl: "ftp://127.0.0.1:8000/v1" })] }), true), /Invalid catalog configuration/);
});

test("enforces one normalized upstream across enabled and disabled models", async () => {
    const path = await write("shared.json", { discoveryProviderId: "test-provider", models: [
        model({ baseUrl: "https://API.EXAMPLE.COM:443/v1/" }),
        model({ id: "other", baseUrl: " https://api.example.com/v1 ", enabled: false }),
    ] });
    assert.deepEqual((await loadCatalog(path)).models.map(item => item.baseUrl), ["https://api.example.com/v1", "https://api.example.com/v1"]);
    for (const baseUrl of ["https://other.example.com/v1", "https://api.example.com/v2"]) {
        await assert.rejects(loadCatalog(await write("multiple.json", { models: [model(), model({ id: "other", baseUrl, enabled: false })] })), /Invalid catalog configuration/);
    }
});

test("discovers models separately for each account without leaking upstream fields", async t => {
    const catalog = await loadCatalog(await write("accounts.json", { discoveryProviderId: "test-provider", models: [model()] }));
    const calls: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://api.example.com/v1/models");
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        calls.push(init);
        const key = (init.headers as Record<string, string>).authorization;
        return Response.json({ data: key === "Bearer account-A-key" ? [
            { id: "gpt-image-2.5", capability: "text", apiKey: "account-A-key", baseUrl: "https://untrusted.example.com" },
            { id: "arbitrary-provider-video", capability: "video" },
        ] : [{ id: "opaque-model", capabilities: ["audio"] }] });
    });
    const accountA = await accountModels(catalog, "account-A-key");
    const accountB = await accountModels(catalog, "account-B-key");
    assert.deepEqual(publicModels({ models: accountA }), [
        { id: "image", name: "Image", capability: "image" },
        { id: "arbitrary-provider-video", name: "arbitrary-provider-video", capability: "video" },
    ]);
    assert.deepEqual(publicModels({ models: accountB }), [{ id: "opaque-model", name: "opaque-model", capability: "audio" }]);
    assert.equal(accountA[0].upstreamModel, "gpt-image-2.5");
    assert.equal(accountA[0].providerId, "test-provider");
    assert.equal(accountA[1].providerId, "test-provider");
    assert.equal(accountB[0].providerId, "test-provider");
    assert.ok([...accountA, ...accountB].every(item => item.baseUrl === catalog.models[0].baseUrl));
    assert.ok(!JSON.stringify(publicModels({ models: accountA })).includes("key"));
    await accountModels(catalog, "account-A-key");
    assert.equal(calls.length, 3);
});

test("uses the account upstream address when one is configured", async t => {
    const catalog = await loadCatalog(await write("account-url.json", { models: [model()] }));
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string) => {
        urls.push(url);
        return Response.json({ data: [{ id: "gpt-image-2.5", capability: "image" }] });
    });
    assert.equal((await accountModels(catalog, "key"))[0].baseUrl, "https://api.example.com/v1");
    assert.equal((await accountModels(catalog, "key", "https://upstream.example.com/v1"))[0].baseUrl, "https://upstream.example.com/v1");
    assert.deepEqual(urls, ["https://api.example.com/v1/models", "https://upstream.example.com/v1/models"]);
});

test("ignores unknown provider fields and falls back to model name keywords", async t => {
    const catalog = await loadCatalog(await write("opaque-provider.json", { models: [model()] }));
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
        { id: "opaque-image-name", domain: "ImageGeneration", status: "Retiring" },
        { id: "opaque-video-name", domain: "VideoGeneration" },
        { id: "opaque-chat-name", domain: "LLM" },
        { id: "known-image", capability: "image" },
        { id: "known-video", capability: "video" },
    ] }));
    const discovered = await accountModels(catalog, "key");
    assert.deepEqual(discovered.map(item => item.capability), ["image", "video", "text", "image", "video"]);
    assert.deepEqual(discovered.map(item => item.id), ["opaque-image-name", "opaque-video-name", "opaque-chat-name", "known-image", "known-video"]);
    assert.ok(discovered.every(item => item.providerId === "test-provider"));
});

test("uses valid capability metadata before model name keyword rules", async t => {
    const catalog = await loadCatalog(await write("capabilities.json", { models: [model()] }));
    const data = [
        { id: "video-with-text-metadata", capability: "text" },
        { id: "opaque-video", capabilities: ["audio"] },
        { id: "VEO-3", capability: "video" },
        { id: "kling-v2", capabilities: ["video"] },
        { id: "wan-2", capability: "video" }, { id: "hailuo-2", capability: "video" }, { id: "sora-2", capability: "video" },
        { id: "tts-1", capability: "audio" }, { id: "voice-model", capability: "audio" },
        { id: "gpt-image-other", capability: "image" }, { id: "seedream-4" },
        { id: "flux-1", capability: "image" }, { id: "plain-model" }, { id: "minimax-h3", capability: "video" }, { id: "MiniMax-M2.7" },
    ];
    t.mock.method(globalThis, "fetch", async () => Response.json({ data }));
    const discovered = await accountModels(catalog, "key");
    assert.deepEqual(discovered.map(item => item.capability), ["text", "audio", "video", "video", "video", "video", "video", "audio", "audio", "image", "image", "image", "text", "video", "text"]);
    assert.ok(discovered.every(item => item.providerId === "test-provider"));
});

test("applies only configured overrides for models present upstream", async t => {
    const catalog = await loadCatalog(await write("overrides.json", { discoveryProviderId: "test-provider", models: [
        model({ id: "opaque", upstreamModel: "actual-video", name: "Custom Video", capability: "video", providerId: "test-provider" }),
        model({ id: "absent", upstreamModel: "not-available" }),
        model({ id: "hidden", upstreamModel: "hidden-model", enabled: false }),
    ] }));
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "actual-video", capability: "text" }, { id: "new-model", capability: "video" }, { id: "hidden-model", capability: "video" }] }));
    const discovered = await accountModels(catalog, "key");
    assert.deepEqual(discovered[0], {
        id: "opaque", name: "Custom Video", upstreamModel: "actual-video", capability: "video", providerId: "test-provider",
        enabled: true, baseUrl: "https://api.example.com/v1",
    });
    assert.equal(discovered[1].id, "new-model");
    assert.equal(discovered[1].upstreamModel, "new-model");
    assert.equal(discovered[1].providerId, "test-provider");
    assert.equal(discovered.length, 3);
    assert.equal(discovered[2].enabled, false);
    assert.equal(publicModels({ models: discovered }).length, 2);
});

test("never falls back to configured models on failure or an empty upstream list", async t => {
    const catalog = await loadCatalog(await write("failures.json", { discoveryProviderId: "test-provider", models: [model()] }));
    let reply = () => Response.json({ data: [] });
    t.mock.method(globalThis, "fetch", async () => reply());
    assert.deepEqual(await accountModels(catalog, "secret-key"), []);
    const failures = [
        () => { throw new Error("secret-key https://private.example.com"); },
        () => new Response("secret-key", { status: 401 }),
        () => new Response("secret-key", { status: 500 }),
        () => new Response(null, { status: 302, headers: { location: "https://other.example.com" } }),
        () => new Response("not JSON"),
        ...[{}, { data: null }, { data: ["model"] }, { data: [{}] }, { data: [{ id: 1 }] }, { data: [{ id: "" }] }].map(body => () => Response.json(body)),
    ];
    for (const failure of failures) {
        reply = failure;
        await assert.rejects(accountModels(catalog, "secret-key"), { message: "Upstream model discovery failed" });
    }
    await assert.rejects(accountModels({ models: [], discoveryProviderId: "test-provider" }, "secret-key"), { message: "Upstream model discovery failed" });
});

test("authenticates only the models route, reads the account key and sanitizes upstream errors", async t => {
    const catalog = await loadCatalog(await write("router.json", { models: [model()] }));
    const encryptionKey = randomBytes(32).toString("base64");
    const sid = Buffer.alloc(32, 1);
    let key: string | null = "account-secret";
    const database = { query: async (sql: string, values: unknown[]) => {
        if (sql.includes("FROM sessions")) {
            assert.ok((values[0] as Buffer).equals(hashSid(sid)));
            return { rows: [{ id: "account-A", email: "a@example.com", expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) {
            assert.equal(values[0], "account-A");
            return { rows: key ? [{ encrypted_api_key: encryptCredential(key, encryptionKey) }] : [] };
        }
        throw new Error("Unexpected query");
    } } as unknown as Pool;
    const app = express();
    app.use(createCatalogRouter(catalog, database, encryptionKey));
    app.get("/public", (_request, response) => response.json({ public: true }));
    const api = await startTestServer(app);
    const nativeFetch = globalThis.fetch;
    let upstreamCalls = 0;
    let fail = false;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        upstreamCalls++;
        assert.equal(url, "https://api.example.com/v1/models");
        assert.equal((init.headers as Record<string, string>).authorization, "Bearer account-secret");
        assert.equal(init.redirect, "error");
        if (fail) throw new Error("account-secret https://private.example.com");
        return Response.json({ data: [{ id: "veo-3", capability: "video", apiKey: "account-secret" }] });
    });
    const headers = { cookie: `infinite_canvas_session=${sid.toString("base64url")}` };
    try {
        assert.equal((await nativeFetch(`${api.baseUrl}/public`)).status, 200);
        assert.equal((await nativeFetch(`${api.baseUrl}/models`)).status, 401);
        key = null;
        assert.equal((await nativeFetch(`${api.baseUrl}/models`, { headers })).status, 409);
        assert.equal(upstreamCalls, 0);
        key = "account-secret";
        const success = await nativeFetch(`${api.baseUrl}/models`, { headers });
        assert.equal(success.status, 200);
        assert.deepEqual(await success.json(), { models: [{ id: "veo-3", name: "veo-3", capability: "video" }] });
        fail = true;
        const failure = await nativeFetch(`${api.baseUrl}/models`, { headers });
        assert.equal(failure.status, 502);
        assert.deepEqual(await failure.json(), { error: { code: "UPSTREAM_ERROR", message: "上游模型获取失败，请检查账号 API Key 和上游服务" } });
    } finally {
        await api.close();
    }
});

test("publishes only enabled model metadata", async () => {
    const path = await write("public.json", { discoveryProviderId: "test-provider", models: [model(), model({ id: "hidden", enabled: false })] });
    const catalog = await loadCatalog(path);
    assert.deepEqual(publicModels(catalog), [{ id: "image", name: "Image", capability: "image" }]);
    assert.equal(resolveModel(catalog, "hidden", "image"), null);
    assert.equal(resolveModel(catalog, "image", "video"), null);
    assert.equal(resolveModel(catalog, "image", "image")?.upstreamModel, "gpt-image-2.5");
});
