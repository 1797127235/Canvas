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
        if (request.path === "/video/v1/videos") return response.status(201).json({ id: "upstream-task", status: "queued" });
        return response.json({ data: [{ b64_json: "aGVsbG8=" }] });
    });
    const provider = await startTestServer(upstream);
    const tasks = new Map<string, { user: string; upstream_id: string; model_id: string }>();
    let activeUser = userA;
    // SAFETY: this minimal Pool test double only implements the parameterized queries exercised by this router.
    const database = { query: async (sql: string, values: any[]) => {
        if (sql.includes("FROM sessions")) {
            activeUser = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id: activeUser, email: `${activeUser}@example.com`, expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential(values[0] === userA ? "test-key-A" : "test-key-B", secret) }] };
        if (sql.includes("INSERT INTO user_generation_tasks")) {
            tasks.set(values[0], { user: values[1], upstream_id: values[2], model_id: values[4] }); return { rows: [] };
        }
        if (sql.includes("FROM user_generation_tasks")) {
            const task = tasks.get(values[0]); return { rows: task?.user === values[1] ? [task] : [] };
        }
        throw new Error("Unexpected query");
    } } as unknown as Pool;
    const catalog = { models: [
        { id: "image", name: "Image 2.5", upstreamModel: "gpt-image-2.5", adapter: "openai-images" as const, capability: "image" as const, enabled: true, baseUrl: `${provider.baseUrl}/image/v1`, apiKey: "image-key" },
        { id: "video", name: "MiniMax H3", upstreamModel: "MiniMax-H3", adapter: "minimax-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/video/v1`, apiKey: "video-key" },
        // Shares the host above: polling must pick this model's key from the stored model id, not the base URL.
        { id: "video-alt", name: "MiniMax H3 Alt", upstreamModel: "MiniMax-H3-Alt", adapter: "minimax-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/video/v1`, apiKey: "video-alt-key" },
    ] };
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createGenerationRouter(database, { catalog }) }));
    const post = (body: unknown) => fetch(`${api.baseUrl}/api/generations`, { method: "POST", headers: { origin, cookie: cookie(sidA), "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${randomUUID()}`)).status, 401);
        assert.equal((await post({ capability: "text", modelId: "image", input: {} })).status, 422);
        assert.equal((await post({ capability: "image", modelId: "video", input: { prompt: "test" } })).status, 404);
        assert.equal((await post({ capability: "image", modelId: "image", input: { prompt: "test", model: "injected", baseUrl: "http://evil" } })).status, 422);
        assert.equal(calls.length, 0);
        const image = await post({ capability: "image", modelId: "image", input: { prompt: "test", n: 1, size: "1024x1024" } });
        assert.equal(image.status, 200);
        assert.equal(calls[0].path, "/image/v1/images/generations");
        assert.equal(JSON.parse(calls[0].body.toString()).model, "gpt-image-2.5");
        assert.equal(calls[0].authorization, "Bearer image-key");
        const ref = "data:image/png;base64,aGVsbG8=";
        assert.equal((await post({ capability: "image", modelId: "image", input: { prompt: "edit", images: [ref] } })).status, 200);
        const editCall = calls[1];
        assert.equal(editCall.path, "/image/v1/images/edits");
        const editForm = await new Response(new Uint8Array(editCall.body), { headers: { "content-type": editCall.contentType! } }).formData();
        assert.equal(editForm.get("model"), "gpt-image-2.5");
        assert.equal(await (editForm.get("image") as File).text(), "hello");
        const video = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [ref], seconds: "6", size: "720x1280" } });
        assert.equal(video.status, 201);
        const { id } = await video.json();
        assert.notEqual(id, "upstream-task");
        const videoBody = JSON.parse(calls[2].body.toString()) as { model: string; resolution: string; ratio: string; image: string };
        assert.equal(calls[2].path, "/video/v1/videos");
        assert.equal(calls[2].authorization, "Bearer video-key");
        assert.equal(videoBody.model, "MiniMax-H3");
        assert.equal(videoBody.resolution, "768P");
        // The client sends pixel sizes; 720x1280 must map to the vertical ratio rather than falling back to 16:9.
        assert.equal(videoBody.ratio, "9:16");
        assert.equal(videoBody.image, ref);
        const ratioCases = [
            { size: "1280x720", ratio: "16:9" }, { size: "1024x1024", ratio: "1:1" },
            { size: "9:16", ratio: "9:16" }, { size: "1920x1080", ratio: "16:9" }, { size: "auto", ratio: "16:9" },
        ];
        for (const item of ratioCases) {
            const index: number = calls.length;
            assert.equal((await post({ capability: "video", modelId: "video", input: { prompt: "video", size: item.size } })).status, 201);
            assert.equal((JSON.parse(calls[index].body.toString()) as { ratio: string }).ratio, item.ratio);
        }
        const alt = await post({ capability: "video", modelId: "video-alt", input: { prompt: "video" } });
        assert.equal(alt.status, 201);
        const { id: altId } = await alt.json();
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${altId}`, { headers: { cookie: cookie(sidA) } })).status, 200);
        assert.equal(calls.at(-1)?.authorization, "Bearer video-alt-key");
        const before = calls.length;
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidB) } })).status, 404);
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${id}/content`, { headers: { cookie: cookie(sidB) } })).status, 404);
        assert.equal(calls.length, before);
        const poll = await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidA) } });
        assert.equal(poll.status, 200);
        assert.equal((await poll.json()).status, "completed");
        assert.equal(calls.at(-1)?.path, "/video/v1/videos/upstream-task");
        const content = await fetch(`${api.baseUrl}/api/generations/${id}/content`, { headers: { cookie: cookie(sidA) } });
        assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
        assert.equal(calls.at(-1)?.authorization, "Bearer video-key");
    } finally { await api.close(); await provider.close(); }
});
