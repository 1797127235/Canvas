import assert from "node:assert/strict";
import { test } from "node:test";
import { generateImage, generateText } from "ai";
import { discoverOpenAICompatibleModels } from "../src/gateway/discovery.js";
import type { ModelBinding } from "../src/gateway/contracts.js";
import { agnesProvider } from "../src/gateway/providers/AgnesAI/index.js";
import { createVideoModel, downloadVideo } from "../src/gateway/providers/AgnesAI/video.js";

const baseUrl = "https://apihub.agnes-ai.com/v1";
const textBinding: ModelBinding = { providerId: "AgnesAI", capability: "text", upstreamModel: "agnes-2.5-flash", baseUrl };
const imageBinding: ModelBinding = { providerId: "AgnesAI", capability: "image", upstreamModel: "agnes-image-2.5-flash", baseUrl };
const videoBinding: ModelBinding = { providerId: "AgnesAI", capability: "video", upstreamModel: "agnes-video-2.5", baseUrl };

test("Agnes text and image models use the documented endpoints", async t => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/chat/completions")) return Response.json({ id: "chat-1", object: "chat.completion", created: 1, model: textBinding.upstreamModel, choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        if (url.endsWith("/images/generations")) return Response.json({ created: 1, data: [{ url: "", b64_json: "aGVsbG8=" }] });
        throw new Error(`Unexpected URL: ${url}`);
    });
    await generateText({ model: agnesProvider.capabilities.text!.model(textBinding, "account-key"), prompt: "hello", maxRetries: 0 });
    await generateImage({ model: agnesProvider.capabilities.image!.model(imageBinding, "account-key"), prompt: "draw a circle", n: 1, size: "1024x1024", maxRetries: 0 });
    assert.deepEqual(calls.map(call => call.url), [`${baseUrl}/chat/completions`, `${baseUrl}/images/generations`]);
    assert.ok(calls.every(call => call.authorization === "Bearer account-key"));
    assert.equal(calls[1].body.model, imageBinding.upstreamModel);
    assert.equal(calls[1].body.size, "1024x1024");
    assert.equal(calls[1].body.ratio, "1:1");
    assert.deepEqual(calls[1].body.extra_body, { response_format: "b64_json" });
});

test("Agnes image editing uses extra_body.image and preserves ratio", async t => {
    let body: Record<string, unknown> | undefined;
    t.mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ created: 1, data: [{ url: "", b64_json: "aGVsbG8=" }] });
    });
    await generateImage({ model: agnesProvider.capabilities.image!.model(imageBinding, "account-key"), prompt: { text: "make it blue", images: ["data:image/png;base64,aW1hZ2U="] }, n: 1, size: "1920x1080", maxRetries: 0 });
    assert.deepEqual(body, {
        model: imageBinding.upstreamModel,
        prompt: "make it blue",
        size: "1920x1080",
        ratio: "16:9",
        extra_body: { image: ["data:image/png;base64,aW1hZ2U="], response_format: "b64_json" },
    });
});

test("Agnes video creates and polls with video_id", async t => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        calls.push({ url, method, body });
        if (method === "POST") return Response.json({ id: "task-1", video_id: "video-1", status: "queued" });
        return Response.json({ id: "task-1", video_id: "video-1", status: "completed", url: "https://cdn.example/video.mp4" });
    });
    const model = createVideoModel(videoBinding, "account-key");
    const start = await model.doStart!({ prompt: "rainy city", n: 1, aspectRatio: "16:9", resolution: "1280x720", duration: 5, fps: undefined, seed: 7, image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: true, providerOptions: {}, abortSignal: undefined });
    assert.deepEqual(start.operation, { videoId: "video-1" });
    assert.deepEqual(calls[0], { url: `${baseUrl}/videos`, method: "POST", body: { model: "agnes-video-2.5", prompt: "rainy city", mode: "text", seconds: "5", size: "720P", aspect_ratio: "16:9", seed: 7, n: 1 } });
    const state = await model.doStatus!({ operation: start.operation });
    assert.equal(state.status, "completed");
    assert.equal(calls[1].url, `${baseUrl.replace("/v1", "")}/agnesapi?video_id=video-1&model_name=agnes-video-2.5`);
    if (state.status === "completed") assert.deepEqual(state.videos, [{ type: "url", url: "https://cdn.example/video.mp4", mediaType: "video/mp4" }]);
    t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", metadata: { url: "https://storage.googleapis.com/agnes-aigc/video.mp4" } }));
    const metadataState = await model.doStatus!({ operation: start.operation });
    assert.equal(metadataState.status, "completed");
    if (metadataState.status === "completed" && metadataState.videos[0]?.type === "url") assert.equal(metadataState.videos[0].url, "https://storage.googleapis.com/agnes-aigc/video.mp4");
});

test("Agnes keyframe and reference inputs map to documented fields", async t => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: URL | RequestInfo, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ video_id: `video-${bodies.length}`, status: "queued" });
    });
    const model = createVideoModel(videoBinding, "account-key");
    const image = { type: "file" as const, data: "aW1hZ2U=", mediaType: "image/png" as const };
    await model.doStart!({ prompt: "keyframe", n: 1, aspectRatio: "9:16", resolution: "720x1280", duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: [{ image, frameType: "first_frame" }], inputReferences: undefined, generateAudio: undefined, providerOptions: { AgnesAI: { imageUrls: ["https://canvas.example/first"] } }, abortSignal: undefined });
    await model.doStart!({ prompt: "reference", n: 1, aspectRatio: "1:1", resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: [image, { ...image, mediaType: "audio/mpeg" as const }], generateAudio: undefined, providerOptions: { AgnesAI: { imageUrls: ["https://canvas.example/image"], audioUrls: ["https://canvas.example/audio"] } }, abortSignal: undefined });
    assert.deepEqual(bodies[0], { model: videoBinding.upstreamModel, prompt: "keyframe", mode: "keyframe", first_frame: "https://canvas.example/first", size: "720P", aspect_ratio: "9:16", n: 1 });
    assert.deepEqual(bodies[1], { model: videoBinding.upstreamModel, prompt: "reference", mode: "reference", size: "720P", aspect_ratio: "1:1", images: ["https://canvas.example/image"], audios: ["https://canvas.example/audio"], n: 1 });
});

test("Agnes discovery authenticates against /models", async t => {
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        assert.equal(String(input), `${baseUrl}/models`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-key");
        return Response.json({ data: [{ id: "agnes-2.5-flash", owned_by: "AgnesAI" }] });
    });
    assert.deepEqual(await discoverOpenAICompatibleModels(`${baseUrl}/`, "account-key"), [{ id: "agnes-2.5-flash", owned_by: "AgnesAI" }]);
});

test("Agnes downloads from the observed CN result host without forwarding credentials", async t => {
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        assert.equal(String(input), "https://cos-platform-outputs.agnes-ai.cn/videos/result.mp4");
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        assert.equal(init?.redirect, "error");
        return new Response("video", { headers: { "content-type": "video/mp4" } });
    });
    const stream = await downloadVideo("https://cos-platform-outputs.agnes-ai.cn/videos/result.mp4", videoBinding, "account-key", new AbortController().signal);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), "video");
    await assert.rejects(downloadVideo("https://cos-platform-outputs.agnes-ai.cn.attacker.example/video.mp4", videoBinding, "account-key", new AbortController().signal), /可信存储范围/);
});

test("Agnes rejects task IDs other than video_id and restricts result hosts", async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ id: "task-only" }));
    await assert.rejects(Promise.resolve(createVideoModel(videoBinding, "account-key").doStart!({ prompt: "test", n: 1, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: undefined, providerOptions: {}, abortSignal: undefined })), /video_id/);
    await assert.rejects(downloadVideo("https://attacker.example/video.mp4", videoBinding, "account-key", new AbortController().signal), /可信存储范围/);
});
