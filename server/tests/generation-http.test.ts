import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createGenerationRouter } from "../src/generation.js";
import { encryptCredential } from "../src/credential-crypto.js";
import { hashSid } from "../src/identity/session.js";
import { startTestServer } from "./support/http.js";

const origin = "http://localhost:3000";
const secret = randomBytes(32).toString("base64");
const sidA = Buffer.alloc(32, 1), sidB = Buffer.alloc(32, 2);
const userA = randomUUID(), userB = randomUUID();
const cookie = (sid: Buffer) => `infinite_canvas_session=${sid.toString("base64url")}`;

test("unified generation validates models, multipart references, task ownership and binary content", async () => {
    const calls: Array<{ path: string; authorization?: string; body: Buffer; contentType?: string }> = [];
    const bytes = Buffer.from([0, 255, 128, 17, 99]);
    const upstream = express();
    upstream.use(express.raw({ type: () => true }));
    upstream.use((request, response) => {
        calls.push({ path: request.path, authorization: request.header("authorization"), body: request.body || Buffer.alloc(0), contentType: request.header("content-type") });
        if (request.path.endsWith("/content")) return response.type("video/mp4").send(bytes);
        if (request.method === "GET") return response.json({ id: "upstream-task", status: "completed" });
        if (request.path === "/v1/videos") return response.status(201).json({ id: "upstream-task", status: "queued" });
        return response.json({ data: [{ b64_json: "aGVsbG8=" }] });
    });
    const provider = await startTestServer(upstream);
    const tasks = new Map<string, { user: string; upstream_id: string; base_url: string }>();
    let activeUser = userA;
    // SAFETY: this minimal Pool test double only implements the parameterized queries exercised by this router.
    const database = { query: async (sql: string, values: any[]) => {
        if (sql.includes("FROM sessions")) {
            activeUser = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id: activeUser, email: `${activeUser}@example.com`, expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential(values[0] === userA ? "test-key-A" : "test-key-B", secret) }] };
        if (sql.includes("INSERT INTO user_generation_tasks")) {
            tasks.set(values[0], { user: values[1], upstream_id: values[2], base_url: values[3] }); return { rows: [] };
        }
        if (sql.includes("FROM user_generation_tasks")) {
            const task = tasks.get(values[0]); return { rows: task?.user === values[1] ? [task] : [] };
        }
        throw new Error("Unexpected query");
    } } as unknown as Pool;
    const catalog = { baseUrl: `${provider.baseUrl}/v1`, models: [
        { id: "image", name: "Image 2.5", upstreamModel: "gpt-image-2.5", adapter: "openai-images" as const, capability: "image" as const, enabled: true },
        { id: "video", name: "MiniMax H3", upstreamModel: "MiniMax-H3", adapter: "openai-videos" as const, capability: "video" as const, enabled: true },
    ] };
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createGenerationRouter(database, { catalog, encryptionKey: secret }) }));
    const post = (body: unknown) => fetch(`${api.baseUrl}/api/generations`, { method: "POST", headers: { origin, cookie: cookie(sidA), "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${randomUUID()}`)).status, 401);
        assert.equal((await post({ capability: "text", modelId: "image", input: {} })).status, 422);
        assert.equal((await post({ capability: "image", modelId: "video", input: { prompt: "test" } })).status, 404);
        assert.equal((await post({ capability: "image", modelId: "image", input: { prompt: "test", model: "injected", baseUrl: "http://evil" } })).status, 422);
        assert.equal(calls.length, 0);
        const image = await post({ capability: "image", modelId: "image", input: { prompt: "test", n: 1, size: "1024x1024" } });
        assert.equal(image.status, 200);
        assert.equal(calls[0].path, "/v1/images/generations");
        assert.equal(JSON.parse(calls[0].body.toString()).model, "gpt-image-2.5");
        assert.equal(calls[0].authorization, "Bearer test-key-A");
        const ref = "data:image/png;base64,aGVsbG8=";
        assert.equal((await post({ capability: "image", modelId: "image", input: { prompt: "edit", images: [ref] } })).status, 200);
        const editCall = calls[1];
        assert.equal(editCall.path, "/v1/images/edits");
        const editForm = await new Response(new Uint8Array(editCall.body), { headers: { "content-type": editCall.contentType! } }).formData();
        assert.equal(editForm.get("model"), "gpt-image-2.5");
        assert.equal(await (editForm.get("image") as File).text(), "hello");
        const video = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [ref], mode: "frames", seconds: "6" } });
        assert.equal(video.status, 201);
        const { id } = await video.json();
        assert.notEqual(id, "upstream-task");
        const videoForm = await new Response(new Uint8Array(calls[2].body), { headers: { "content-type": calls[2].contentType! } }).formData();
        assert.equal(videoForm.get("model"), "MiniMax-H3");
        assert.equal(await (videoForm.get("first_frame") as File).text(), "hello");
        const before = calls.length;
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidB) } })).status, 404);
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${id}/content`, { headers: { cookie: cookie(sidB) } })).status, 404);
        assert.equal(calls.length, before);
        const poll = await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidA) } });
        assert.equal(poll.status, 200);
        assert.equal((await poll.json()).status, "completed");
        assert.equal(calls.at(-1)?.path, "/v1/videos/upstream-task");
        const content = await fetch(`${api.baseUrl}/api/generations/${id}/content`, { headers: { cookie: cookie(sidA) } });
        assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
        assert.equal(calls.at(-1)?.authorization, "Bearer test-key-A");
    } finally { await api.close(); await provider.close(); }
});
