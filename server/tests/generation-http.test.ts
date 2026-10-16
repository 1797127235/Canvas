import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createGenerationRouter } from "../src/generation.js";
import { createMediaRouter } from "../src/media.js";
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
    const directory = await mkdtemp(join(tmpdir(), "generation-refs-"));
    // 参考素材现在按身份（remote:<uuid>）提交，字节由服务端从账号媒体读取；这里用真实目录代替存储。
    const mediaFiles = new Map<string, { user: string; object_key: string; mimeType: string }>();
    const putMedia = async (user: string, mimeType: string, bytes: Buffer) => {
        const id = randomUUID();
        const objectKey = `${user}/${id}`;
        await mkdir(join(directory, user), { recursive: true });
        await writeFile(join(directory, objectKey), bytes);
        mediaFiles.set(id, { user, object_key: objectKey, mimeType });
        return `remote:${id}`;
    };
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
        if (request.path === "/v1/chat/completions") return response.type("text/event-stream").send('data: {"id":"chat","created":1,"model":"chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"chat","created":1,"model":"chat-model","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        return response.json({ data: [{ b64_json: "aGVsbG8=" }] });
    });
    const provider = await startTestServer(upstream);
    const tasks = new Map<string, { user: string; operation: unknown; model_id: string; base_url: string; result?: unknown }>();
    const history = new Map<string, unknown>();
    const storedMedia = new Map<string, { user: string; object_key: string; mimeType: string }>();
    let activeUser = userA;
    // SAFETY: this minimal Pool test double only implements the parameterized queries exercised by this router.
    const database = { query: async (sql: string, values: any[]) => {
        if (sql.includes("FROM sessions")) {
            activeUser = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id: activeUser, email: `${activeUser}@example.com`, expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential(values[0] === userA ? "test-key-A" : "test-key-B", secret) }] };
        if (sql.includes("FROM user_media")) {
            const file = mediaFiles.get(values[0]);
            if (!file || file.user !== values[1]) return { rows: [] };
            return { rows: [{ object_key: file.object_key, mime_type: file.mimeType }] };
        }
        if (sql.includes("INSERT INTO user_media")) {
            storedMedia.set(values[0], { user: values[1], object_key: values[2], mimeType: values[3] });
            return { rows: [] };
        }
        if (sql.includes("INSERT INTO user_generation_tasks")) {
            tasks.set(values[0], { user: values[1], operation: JSON.parse(values[2]), model_id: values[4], base_url: values[3] }); return { rows: [] };
        }
        if (sql.startsWith("UPDATE user_generation_tasks SET result")) {
            const task = tasks.get(values[0]);
            if (task) task.result = JSON.parse(values[1]);
            return { rows: [] };
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
        { id: "video", name: "Seedance", upstreamModel: "doubao-seedance-2-0-mini", adapter: "gateway-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
        { id: "video-alt", name: "Seedance Alt", upstreamModel: "doubao-seedance-2-0", adapter: "gateway-videos" as const, capability: "video" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
    ] };
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createGenerationRouter(database, { catalog, encryptionKey: secret, media: { directory } }) }));
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
        const ref = await putMedia(userA, "image/png", Buffer.from("hello"));
        const resolvedRef = "data:image/png;base64,aGVsbG8=";
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
        assert.deepEqual(videoPayload.image, { url: resolvedRef });
        const alt = await post({ capability: "video", modelId: "video-alt", input: { prompt: "video" } });
        assert.equal(alt.status, 201);
        const { id: altId } = await alt.json();
        assert.equal(JSON.parse(calls[3].body.toString()).model, "doubao-seedance-2-0");
        const bigBuffer = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 30 } } }).png().toBuffer();
        assert.ok(bigBuffer.length > 512 * 1024);
        const bigRef = await putMedia(userA, "image/png", bigBuffer);
        const bigVideo = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [bigRef], seconds: "5" } });
        assert.equal(bigVideo.status, 201);
        const normalizedUrl = JSON.parse(calls.at(-1)!.body.toString()).image.url as string;
        assert.match(normalizedUrl, /^data:image\/jpeg;base64,/);
        assert.ok(Buffer.from(normalizedUrl.split(",")[1], "base64").length <= 512 * 1024);
        const multiVideo = await post({ capability: "video", modelId: "video", input: { prompt: "video", images: [ref, bigRef], seconds: "5" } });
        assert.equal(multiVideo.status, 201);
        const multiPayload = JSON.parse(calls.at(-1)!.body.toString());
        assert.equal(multiPayload.model, "doubao-seedance-2-0-mini");
        assert.deepEqual(multiPayload.image, { url: resolvedRef });
        assert.match(multiPayload.last_frame.url, /^data:image\/jpeg;base64,/);
        assert.ok(Buffer.from(multiPayload.last_frame.url.split(",")[1], "base64").length <= 512 * 1024);
        assert.equal(multiPayload.reference_images, undefined);
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${altId}`, { headers: { cookie: cookie(sidA) } })).status, 200);
        assert.equal(calls.at(-1)?.authorization, "Bearer test-key-A");
        const before = calls.length;
        assert.equal((await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidB) } })).status, 404);
        assert.equal(calls.length, before);
        const poll = await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidA) } });
        assert.equal(poll.status, 200);
        const polled = await poll.json() as { status: string; mediaId?: string };
        assert.equal(polled.status, "completed");
        // 首次完成：先查状态，再下载一次视频存进账号媒体；字节不再经浏览器中转。
        assert.equal(calls.at(-2)?.path, "/v1/videos/upstream-task");
        assert.equal(calls.at(-1)?.path, "/v1/videos/upstream-task/content");
        const videoMedia = storedMedia.get(polled.mediaId!)!;
        assert.ok(videoMedia, "video must be stored in account media");
        assert.equal(videoMedia.mimeType, "video/mp4");
        assert.deepEqual(await readFile(join(directory, videoMedia.object_key)), bytes);
        // 重复轮询直接复用已落库结果，不再重复下载上游视频。
        const again = await fetch(`${api.baseUrl}/api/generations/${id}`, { headers: { cookie: cookie(sidA) } });
        assert.equal((await again.json() as { mediaId?: string }).mediaId, polled.mediaId);
        assert.equal(calls.at(-1)?.path, "/v1/videos/upstream-task");
        const audio = await post({ capability: "audio", modelId: "speech-model", input: { input: "speech", voice: "alloy", response_format: "mp3" } });
        assert.equal(audio.status, 200);
        const audioPayload = await audio.json() as { mediaId: string; mimeType: string; bytes: number };
        assert.equal(audioPayload.mimeType, "audio/mpeg");
        assert.equal(audioPayload.bytes, bytes.length);
        assert.deepEqual(await readFile(join(directory, storedMedia.get(audioPayload.mediaId)!.object_key)), bytes);
        const text = await post({ capability: "text", modelId: "chat-model", input: { messages: [{ role: "user", content: "hi" }], stream: true } });
        assert.equal(text.status, 200);
        const streamed = await text.text();
        assert.match(streamed, /hello/);
        assert.match(streamed, / world/);
        assert.match(streamed, /\[DONE\]/);
        assert.doesNotMatch(streamed, /UPSTREAM_ERROR/);
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
    } finally { await api.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test("image generation runs as a background task, bridges url results and stores account media", async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    let imageCalls = 0;
    let lastImageRequest: { model?: string; authorization?: string } | undefined;
    const upstream = express();
    upstream.use(express.json());
    upstream.use((request, response) => {
        if (request.path === "/v1/models") return response.json({ data: [{ id: "gpt-image-2.5", capability: "image" }] });
        if (request.path === "/v1/images/generations") {
            imageCalls++;
            lastImageRequest = { model: request.body.model, authorization: request.header("authorization") };
            return response.json({ created: 1, data: [{ url: `${request.protocol}://${request.get("host")}/files/result.png` }], usage: {} });
        }
        if (request.path === "/files/result.png") return response.type("image/png").send(png);
        return response.status(404).end();
    });
    const provider = await startTestServer(upstream);
    const directory = await mkdtemp(join(tmpdir(), "image-task-media-"));
    const tasks = new Map<string, { user: string; kind: string; status?: string; result?: string; error?: string; created_at: Date }>();
    const media = new Map<string, { user: string; object_key: string; mime_type: string; byte_size: number }>();
    const database = { query: async (sql: string, values: any[]) => {
        if (sql.includes("FROM sessions")) {
            const user = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id: user, email: `${user}@example.com`, expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("FROM user_credentials")) return { rows: [{ encrypted_api_key: encryptCredential("test-key-A", secret) }] };
        if (sql.startsWith("INSERT INTO user_generation_tasks")) {
            // SQL 里 kind/status 是字面量 'image'/'running'，operation 是最后一个参数。
            tasks.set(values[0], { user: values[1], kind: "image", status: "running", created_at: new Date() });
            return { rows: [] };
        }
        if (sql.startsWith("SELECT kind, status, result, error, created_at")) {
            const task = tasks.get(values[0]);
            if (!task || task.user !== values[1]) return { rows: [] };
            return { rows: [{ kind: task.kind, status: task.status, result: task.result ?? null, error: task.error ?? null, created_at: task.created_at }] };
        }
        if (sql.startsWith("UPDATE user_generation_tasks SET status = 'completed'")) {
            const task = tasks.get(values[0]);
            // pg 的 JSONB 列返回的是解析后的对象，测试双胞胎保持一致。
            if (task) { task.status = "completed"; task.result = JSON.parse(values[1]); }
            return { rows: [] };
        }
        if (sql.startsWith("UPDATE user_generation_tasks SET status = 'failed'")) {
            const task = tasks.get(values[0]);
            if (task) { task.status = "failed"; task.error = values[1]; }
            return { rows: [] };
        }
        if (sql.startsWith("INSERT INTO user_media")) {
            media.set(values[0], { user: values[1], object_key: values[2], mime_type: values[3], byte_size: values[4] });
            return { rows: [] };
        }
        if (sql.startsWith("SELECT object_key, mime_type, byte_size FROM user_media")) {
            const file = media.get(values[0]);
            if (!file || file.user !== values[1]) return { rows: [] };
            return { rows: [{ object_key: file.object_key, mime_type: file.mime_type, byte_size: String(file.byte_size) }] };
        }
        console.log("SQL:", sql.slice(0, 70));
        throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    } } as unknown as Pool;
    const catalog = { models: [
        { id: "image", name: "Image 2.5", upstreamModel: "gpt-image-2.5", adapter: "openai-images" as const, capability: "image" as const, enabled: true, baseUrl: `${provider.baseUrl}/v1` },
    ] };
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createMediaRouter(database, { directory }).use(createGenerationRouter(database, { catalog, encryptionKey: secret, media: { directory } })) }));
    const headers = { origin, cookie: cookie(sidA), "content-type": "application/json" };
    try {
        // 前端预生成任务号：节点在发请求前就持有它，刷新后可直接按号恢复，所以服务端必须原样采纳。
        const preTaskId = randomUUID();
        const preCreated = await fetch(`${api.baseUrl}/api/generation-tasks`, { method: "POST", headers, body: JSON.stringify({ capability: "image", taskId: preTaskId, modelId: "image", input: { prompt: "预生成任务号", n: 1, size: "1024x1024" } }) });
        assert.equal(preCreated.status, 201);
        assert.equal((await preCreated.json() as { id: string }).id, preTaskId);
        // 非法任务号必须被拒，不能让任意字符串进数据库。
        const invalid = await fetch(`${api.baseUrl}/api/generation-tasks`, { method: "POST", headers, body: JSON.stringify({ capability: "image", taskId: "not-a-uuid", modelId: "image", input: { prompt: "奶龙", n: 1, size: "1024x1024" } }) });
        assert.equal(invalid.status, 422);
        const baseline = imageCalls;
        const create = await fetch(`${api.baseUrl}/api/generation-tasks`, { method: "POST", headers, body: JSON.stringify({ capability: "image", modelId: "image", input: { prompt: "奶龙", n: 1, size: "1024x1024" } }) });
        assert.equal(create.status, 201);
        const { id, status } = await create.json() as { id: string; status: string };
        assert.equal(status, "running");
        const others = { origin, cookie: cookie(sidB) };
        assert.equal((await fetch(`${api.baseUrl}/api/generation-tasks/${id}`, { headers: others })).status, 404);
        type ImageTaskState = { status: string; images?: Array<{ id: string; mimeType: string; bytes: number; width: number; height: number }>; error?: string };
        let state: ImageTaskState | undefined;
        for (let index = 0; index < 40; index++) {
            const poll = await fetch(`${api.baseUrl}/api/generation-tasks/${id}`, { headers: { origin, cookie: cookie(sidA) } });
            state = await poll.json() as ImageTaskState;

            if (state.status !== "running") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(state?.status, "completed");
        assert.equal(state?.images?.length, 1);
        const result = state!.images![0];
        // 结果直接带素材元数据，客户端凭 id 引用即可，不必取回字节再重新上传。
        assert.equal(result.mimeType, "image/png");
        assert.equal(result.bytes, png.length);
        // 测试用的 png 只有文件签名、没有可读的尺寸头；读不到尺寸时任务仍成功，宽高记为 0。
        assert.equal(result.width, 0);
        assert.equal(result.height, 0);
        assert.equal(imageCalls, baseline + 1);
        assert.equal(lastImageRequest?.model, "gpt-image-2.5");
        assert.equal(lastImageRequest?.authorization, "Bearer test-key-A");
        const bytes = await (await fetch(`${api.baseUrl}/api/media/${result.id}`, { headers: { origin, cookie: cookie(sidA) } })).arrayBuffer();
        assert.deepEqual(new Uint8Array(bytes), new Uint8Array(png));
        assert.equal((await fetch(`${api.baseUrl}/api/media/${result.id}`, { headers: { origin, cookie: cookie(sidB) } })).status, 404);
    } finally { await api.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
});
