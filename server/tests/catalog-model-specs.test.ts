import assert from "node:assert/strict";
import { test } from "node:test";
import { accountModels, publicModels } from "../src/catalog/catalog.js";
import { createModelsDevLoader } from "../src/catalog/models-dev.js";
import { withModelSpecs } from "../src/catalog/specs.js";
import { randomBytes } from "node:crypto";
import express from "express";
import type { Pool } from "pg";
import { createCatalogRouter } from "../src/catalog/router.js";
import { encryptCredential } from "../src/credential-crypto.js";
import { startTestServer } from "./support/http.js";

import { registerTestProvider } from "./support/test-provider.js";
import { gateway } from "../src/gateway/index.js";

registerTestProvider(gateway);
const entry = { name: "Example Chat", limit: { context: 128000, input: 120000, output: 8000 }, tool_call: true, reasoning: false, structured_output: true, modalities: { input: ["text", "image"], output: ["text"] } };

test("enriches only available models with canonical specs and preserves routing", async (t) => {
    const loadSpecs = createModelsDevLoader(async () => Response.json({ "lab/chat": entry, "other/chat": entry, "lab/absent": entry }));
    const catalog = { models: [], discoveryProviderId: "test-provider" };
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://upstream.example/v1/models");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer account-key");
        return Response.json({ data: [{ id: "chat", owned_by: "lab", capability: "text" }, { id: "unknown", capability: "text" }] });
    });
    const models = await withModelSpecs(await accountModels(catalog, "account-key", "https://upstream.example/v1"), loadSpecs);
    assert.equal(models.length, 2);
    assert.equal(models[0].upstreamModel, "chat");
    assert.equal(models[0].providerId, "test-provider");
    assert.equal(models[0].baseUrl, "https://upstream.example/v1");
    const metadata = publicModels({ models });
    assert.deepEqual(JSON.parse(JSON.stringify(metadata[0])), {
        id: "chat", name: "chat", capability: "text",
        spec: { canonicalId: "lab/chat", name: entry.name, limit: entry.limit, toolCall: true, reasoning: false, structuredOutput: true, modalities: entry.modalities, source: "models.dev" },
    });
    assert.deepEqual(metadata[1], { id: "unknown", name: "unknown", capability: "text" });
    assert.equal(JSON.stringify(metadata).includes("account-key"), false);
    assert.equal(JSON.stringify(metadata).includes("upstream.example"), false);
});

test("unavailable supplemental metadata does not break account model discovery", async (t) => {
    const loadSpecs = createModelsDevLoader(async () => new Response(null, { status: 503 }));
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "chat", capability: "text" }] }));
    const models = await withModelSpecs(await accountModels({ models: [], discoveryProviderId: "test-provider" }, "key", "https://upstream.example/v1"), loadSpecs);
    assert.deepEqual(publicModels({ models }), [{ id: "chat", name: "chat", capability: "text" }]);
});


test("discovery never requests reference specs and enrichment preserves explicit bindings", async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "chat", owned_by: "lab", capability: "text" }] }));
    let specCalls = 0;
    const loadSpecs = async () => { specCalls++; throw new Error("reference service unavailable"); };
    const catalog = { models: [], discoveryProviderId: "test-provider", loadSpecs };
    const models = await accountModels(catalog, "key", "https://upstream.example/v1");
    assert.equal(specCalls, 0);
    assert.equal(models[0].spec, undefined);
    assert.equal(models[0].specProviderId, "lab");
    assert.equal(await withModelSpecs(models, loadSpecs), models);
    assert.equal(specCalls, 1);
    await withModelSpecs([], loadSpecs);
    assert.equal(specCalls, 1);
});

test("model HTTP endpoint enriches reference metadata and survives metadata failure", async t => {
    const encryptionKey = randomBytes(32).toString("base64");
    const sid = Buffer.alloc(32, 7);
    const database = { query: async (sql: string) => {
        if (sql.includes("FROM sessions")) return { rows: [{ id: "user", email: "u@example.com", expires_at: new Date("2099-01-01") }] };
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential("account-key", encryptionKey), base_url: "https://upstream.example/v1" }] };
        throw new Error("Unexpected query");
    } } as unknown as Pool;
    const specs = await createModelsDevLoader(async () => Response.json({ "lab/chat": entry }))();
    let fail = false;
    const app = express();
    app.use(createCatalogRouter({ models: [], discoveryProviderId: "test-provider" }, database, encryptionKey, async () => {
        if (fail) throw new Error("account-key must not leak");
        return specs;
    }));
    const api = await startTestServer(app);
    const nativeFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "chat", owned_by: "lab", capability: "text" }] }));
    const headers = { cookie: `infinite_canvas_session=${sid.toString("base64url")}` };
    try {
        const enriched = await nativeFetch(`${api.baseUrl}/models`, { headers });
        assert.equal(enriched.status, 200);
        const body = await enriched.json();
        assert.equal(body.models[0].spec.canonicalId, "lab/chat");
        assert.equal(body.models[0].specProviderId, undefined);
        assert.equal(JSON.stringify(body).includes("account-key"), false);
        fail = true;
        const plain = await nativeFetch(`${api.baseUrl}/models`, { headers });
        assert.equal(plain.status, 200);
        assert.deepEqual(await plain.json(), { models: [{ id: "chat", name: "chat", capability: "text" }] });
    } finally { await api.close(); }
});
