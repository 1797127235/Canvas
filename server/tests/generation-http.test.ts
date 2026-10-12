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
import sharp from "sharp";

const origin = "http://localhost:3000";
const secret = randomBytes(32).toString("base64");
const sidA = Buffer.alloc(32, 1), sidB = Buffer.alloc(32, 2);
const userA = randomUUID(), userB = randomUUID();
const cookie = (sid: Buffer) => `infinite_canvas_session=${sid.toString("base64url")}`;

test("unified generation validates models, multipart references, task ownership and binary content", async () => {
    const calls: Array<{ path: string; authorization?: string; body: Buffer; contentType?: string }> = [];
    const bytes = Buffer.from([0, 255, 128, 17, 99]);
    const upstream = express();
    upstream.use(express.raw({ type: () => true, limit: "32mb" }));
    upstream.use((request, response) => {
        if (request.path === "/v1/models") return response.json({ data: [
            { id: "gpt-image-2.5", capability: "image" }, { id: "doubao-seedance-2-0-mini", capability: "video" },
            { id: "doubao-seedance-2-0", capability: "video" }, { id: "chat-model", capability: "text" }, { id: "speech-model", capability: "audio" },
        ] });
        calls.push({ path: request.path, authorization: request.header("authorization"), body: request.body || Buffer.alloc(0), contentType: request.header("content-type") });
        if (request.path.endsWith("/content")) return response.type("video/mp4").send(bytes);
        if (request.method === "GET") return response.json({ id: "upstream-task", status: "completed" });
        if (request.path === "/v1/videos") return response.status(201).json({ request_id: "upstream-task", status: "queued" });
        if (request.path === "/v1/audio/speech") return response.type("audio/mpeg").send(bytes);
        if (request.path === "/v1/chat/completions") return response.type("text/event-stream").send('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
        return response.json({ data: [{ b64_json: "aGVsbG8=" }] });
    });
    const provider = await startTestServer(upstream);
    const tasks = new Map<string, { user: string; upstream_id: string; model_id: string; base_url: string }>();
    const history = new Map<string, unknown>();
    let activeUser = userA;
    // SAFETY: this minimal Pool test double only implements the parameterized queries exercised by this router.
    const database = { query: async (sql: string, values: any[]) => {
        if (sql.includes("FROM sessions")) {
            activeUser = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id: activeUser, email: `${activeUser}@example.com`, expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential(values[0] === userA ? "test-key-A" : "test-key-B", secret) }] };
        if (sql.includes("INSERT INTO user_generation_tasks")) {
            tasks.set(values[0], { user: values[1], upstream_id: values[2], model_id: values[4], base_url: values[3] }); return { rows: [] };
        }
        if (sql.includes("FROM user_generation_tasks")) {
            const task = tasks.get(values[0]); return { rows: task?.user === values[1] ? [task] : [] };
        }
        if (sql.includes("user_generation_history")) {
            const prefix = `${values[0]}:${values[1]}:`;
            if (sql.startsWith("INSERT")) history.set(`${prefix}${values[2]}`, values[3]);
            if (sql.startsWith("DELETE")) history.delete(`${prefix}${values[2]}`);
            return { rows: [...history].filter(([key]) => key.startsWith(prefix)).map(([, data]) => ({ data })) };
        }
        throw new Error("Unexpected query");
    } } as unknown as Pool;
    const catalog = { models: [
        { id: "image", name: "Image 2.5", upstreamModel: "gpt-image-2.5", adapter: "openai-images" as const, capability: "image" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
        { id: "video", name: "Seedance", upstreamModel: "doubao-seedance-2-0-mini", adapter: "openai-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
        { id: "video-alt", name: "Seedance Alt", upstreamModel: "doubao-seedance-2-0", adapter: "openai-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
    ] };
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createGenerationRouter(database, { catalog, encryptionKey: secret }) }));
    const post = (body: unknown) => fetch(`${api.baseUrl}/api/generations`, { method: "POST", headers: { origin, cookie: cookie(sidA), "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${randomUUID()}`)).status, 401);
        assert.equal((await post({ capability: "text", modelId: "image", input: {} })).status, 422);
        assert.equal((await post({ capability: "image", modelId: "video", input: { prompt: "test" } })).status, 404);
        assert.equal((await post({ capability: "image", modelId: "image", input: { prompt: "test", model: "injected", baseUrl: "http://evil" } })).status, 422);
        assert.equal(calls.length, 0);
        const missingKey = { query: async (sql: string) => {
            if (sql.includes("FROM sessions")) return { rows: [{ id: userA, email: "a@example.com", expires_at: new Date("2099-01-01") }] };
            if (sql.includes("FROM user_credentials")) return { rows: [] };
            throw new Error("Unexpected query");
        } } as unknown as Pool;
        const blocked = await startTestServer(createApp({ appOrigin: origin, apiRouter: createGenerationRouter(missingKey, { catalog, encryptionKey: secret }) }));
        const blockedResponse = await fetch(`${blocked.baseUrl}/api/generations`, { method: "POST", headers: { origin, cookie: cookie(sidA), "content-type": "application/json" }, body: JSON.stringify({ capability: "image", modelId: "image", input: { prompt: "test" } }) });
        assert.equal(blockedResponse.status, 409);
        await blocked.close();
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
        const video = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [ref], seconds: "5", size: "496x864", resolution_name: "480p", generate_audio: true, watermark: false, mode: "frames" } });
        assert.equal(video.status, 201);
        const { id } = await video.json();
        assert.notEqual(id, "upstream-task");
        assert.equal(calls[2].path, "/v1/videos");
        assert.equal(calls[2].contentType, "application/json");
        assert.equal(calls[2].authorization, "Bearer test-key-A");
        const videoPayload = JSON.parse(calls[2].body.toString());
        assert.equal(videoPayload.model, "doubao-seedance-2-0-mini");
        assert.equal(videoPayload.prompt, "video");
        assert.equal(videoPayload.duration, 5);
        assert.equal(videoPayload.resolution, "480p");
        assert.equal(videoPayload.aspect_ratio, "9:16");
        assert.equal(videoPayload.generate_audio, true);
        assert.equal(videoPayload.watermark, false);
        assert.deepEqual(videoPayload.image, { url: ref });
        const alt = await post({ capability: "video", modelId: "video-alt", input: { prompt: "video" } });
        assert.equal(alt.status, 201);
        const { id: altId } = await alt.json();
        assert.equal(JSON.parse(calls[3].body.toString()).image, undefined);
        const bigBuffer = await sharp({ create: { width: 2000, height: 2000, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 30 } } }).png().toBuffer();
        assert.ok(bigBuffer.length > 512 * 1024);
        const bigVideo = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [`data:image/png;base64,${bigBuffer.toString("base64")}`], seconds: "5" } });
        assert.equal(bigVideo.status, 201);
        const normalizedUrl = JSON.parse(calls.at(-1)!.body.toString()).image.url as string;
        assert.match(normalizedUrl, /^data:image\/jpeg;base64,/);
        assert.ok(Buffer.from(normalizedUrl.split(",")[1], "base64").length <= 512 * 1024);
        const multiVideo = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [ref, `data:image/png;base64,${bigBuffer.toString("base64")}`], seconds: "5" } });
        assert.equal(multiVideo.status, 201);
        const multiPayload = JSON.parse(calls.at(-1)!.body.toString());
        assert.equal(multiPayload.image, undefined);
        assert.equal(multiPayload.reference_images.length, 2);
        assert.equal(multiPayload.reference_images[0].url, ref);
        assert.ok(Buffer.from(multiPayload.reference_images[1].url.split(",")[1], "base64").length <= 512 * 1024);
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${altId}`, { headers: { cookie: cookie(sidA) } })).status, 200);
        assert.equal(calls.at(-1)?.authorization, "Bearer test-key-A");
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
        const audio = await post({ capability: "audio", modelId: "speech-model", input: { input: "speech", voice: "alloy", response_format: "mp3" } });
        assert.equal(audio.headers.get("content-type"), "audio/mpeg");
        assert.deepEqual(Buffer.from(await audio.arrayBuffer()), bytes);
        const text = await post({ capability: "text", modelId: "chat-model", input: { messages: [{ role: "user", content: "hi" }], stream: true } });
        assert.equal(text.status, 200);
        assert.match(await text.text(), /hello/);
        assert.equal(calls.at(-1)?.path, "/v1/chat/completions");
        assert.equal(JSON.parse(calls.at(-1)!.body.toString()).model, "chat-model");
        const historyUrl = `${api.baseUrl}/api/generation-history/image`;
        const historyHeaders = { origin, cookie: cookie(sidA), "content-type": "application/json" };
        assert.equal((await fetch(`${historyUrl}/record`, { method: "PUT", headers: historyHeaders, body: JSON.stringify({ id: "record", prompt: "private" }) })).status, 204);
        assert.deepEqual(await (await fetch(historyUrl, { headers: { cookie: cookie(sidB) } })).json(), { logs: [] });
        await fetch(`${historyUrl}/record`, { method: "DELETE", headers: { origin, cookie: cookie(sidB) } });
        assert.deepEqual(await (await fetch(historyUrl, { headers: { cookie: cookie(sidA) } })).json(), { logs: [{ id: "record", prompt: "private" }] });
        await fetch(`${historyUrl}/record`, { method: "DELETE", headers: historyHeaders });
        assert.deepEqual(await (await fetch(historyUrl, { headers: { cookie: cookie(sidA) } })).json(), { logs: [] });
    } finally { await api.close(); await provider.close(); }
});
