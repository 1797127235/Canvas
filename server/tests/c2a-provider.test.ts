import assert from "node:assert/strict";
import { test } from "node:test";
import { generateImage, generateText } from "ai";
import { discoverOpenAICompatibleModels } from "../src/gateway/discovery.js";
import type { ModelBinding } from "../src/gateway/contracts.js";
import { c2aProvider } from "../src/gateway/providers/C2A/index.js";
import { createVideoModel, downloadVideo } from "../src/gateway/providers/C2A/video.js";

const binding: ModelBinding = {
    providerId: "C2A",
    capability: "video",
    upstreamModel: "grok-imagine-video-1.5",
    baseUrl: "https://gateway.example/v1",
};

test("C2A text and image models use OpenAI-compatible endpoints", async t => {
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        calls.push({ url, body, authorization: new Headers(init?.headers).get("authorization") });
        if (url.endsWith("/chat/completions")) return Response.json({ id: "chat-1", object: "chat.completion", created: 1, model: "chat-test", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        if (url.endsWith("/images/generations")) return Response.json({ created: 1, data: [{ b64_json: "aGVsbG8=" }] });
        throw new Error(`Unexpected URL: ${url}`);
    });
    const textBinding = { ...binding, capability: "text" as const, upstreamModel: "chat-test" };
    const imageBinding = { ...binding, capability: "image" as const, upstreamModel: "image-test" };
    const text = c2aProvider.capabilities.text!.model(textBinding, "account-key");
    const image = c2aProvider.capabilities.image!.model(imageBinding, "account-key");
    await generateText({ model: text, prompt: "hello", maxRetries: 0 });
    await generateImage({ model: image, prompt: "draw a circle", n: 1, maxRetries: 0 });
    assert.deepEqual(calls.map(call => call.url), ["https://gateway.example/v1/chat/completions", "https://gateway.example/v1/images/generations"]);
    assert.ok(calls.every(call => call.authorization === "Bearer account-key"));
    assert.equal(calls[0].body.model, textBinding.upstreamModel);
    assert.equal(calls[0].body.messages instanceof Array, true);
    assert.equal(calls[1].body.model, imageBinding.upstreamModel);
    assert.equal(calls[1].body.prompt, "draw a circle");
});

test("OpenAI-compatible discovery validates /models and authenticates with the account key", async t => {
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        assert.equal(String(input), "https://gateway.example/v1/models");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-key");
        return Response.json({ data: [{ id: "gpt-test", owned_by: "vendor-label" }] });
    });
    assert.deepEqual(await discoverOpenAICompatibleModels("https://gateway.example/v1/", "account-key"), [
        { id: "gpt-test", owned_by: "vendor-label" },
    ]);
});

test("Codex2API video model creates, polls and returns the content URL", async t => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (method === "POST") return Response.json({ request_id: "request-123" }, { headers: { "x-task": "created" } });
        return Response.json({ status: "done", video: { url: "https://gateway.example/v1/videos/request-123/content" } });
    });
    const model = createVideoModel(binding, "account-key");
    assert.ok(model.doStart && model.doStatus);
    const start = await model.doStart({ prompt: "A moving landscape", n: 1, aspectRatio: "16:9", resolution: "1280x720", duration: 5, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: undefined, generateAudio: true, providerOptions: { C2A: { resolution: "720p" } }, abortSignal: undefined });
    assert.deepEqual(start.operation, { requestId: "request-123" });
    assert.equal(calls[0].url, "https://gateway.example/v1/videos/generations");
    assert.deepEqual(calls[0].body, { model: "grok-imagine-video-1.5", prompt: "A moving landscape", duration: 5, aspect_ratio: "16:9", resolution: "720p" });

    const state = await model.doStatus({ operation: start.operation });
    assert.equal(state.status, "completed");
    if (state.status === "completed") assert.deepEqual(state.videos, [{ type: "url", url: "https://gateway.example/v1/videos/generations/request-123/content", mediaType: "video/mp4" }]);
    assert.equal(calls[1].url, "https://gateway.example/v1/videos/generations/request-123");
});

test("Codex2API video download refuses URLs outside the configured gateway", async () => {
    await assert.rejects(downloadVideo("https://attacker.example/v1/videos/x/content", binding, "account-key", new AbortController().signal), /不在已配置的网关内/);
    await assert.rejects(downloadVideo("not-a-url", binding, "account-key", new AbortController().signal), /地址无效/);
});

test("only documented Grok video models are accepted and unsupported references fail explicitly", async () => {
    assert.throws(() => createVideoModel({ ...binding, upstreamModel: "other-video-model" }, "account-key"), /暂未适配模型/);
    const model = createVideoModel(binding, "account-key");
    await assert.rejects(Promise.resolve(model.doStart!({ prompt: "test", n: 1, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: [{ type: "file", data: "AAAA", mediaType: "video/mp4" }], generateAudio: undefined, providerOptions: {}, abortSignal: undefined })), /只支持图片参考/);
});

test("C2A image-to-video accepts the app audio default and preserves signed image references", async t => {
    const bodies: Record<string, unknown>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ request_id: "image-video" });
    });
    const capability = c2aProvider.capabilities.video;
    const model = createVideoModel(binding, "account-key");
    const image = { type: "file" as const, data: "aGVsbG8=", mediaType: "image/png" };
    for (const generateAudio of [true, false]) {
        capability.validateInput!({ generateAudio, frameCount: 1 });
        await model.doStart!({ prompt: "animate", n: 1, aspectRatio: "9:16", resolution: undefined, duration: 6, fps: undefined, seed: undefined, image: undefined, frameImages: [{ image, frameType: "first_frame" }], inputReferences: undefined, generateAudio, providerOptions: { C2A: { imageUrls: ["https://canvas.example/api/media/image?expires=123&token=signed"] } }, abortSignal: undefined });
        assert.deepEqual(bodies.at(-1), { model: binding.upstreamModel, prompt: "animate", duration: 6, aspect_ratio: "9:16", image: { url: "https://canvas.example/api/media/image?expires=123&token=signed" } });
    }
    await model.doStart!({ prompt: "references", n: 1, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: undefined, inputReferences: [image, image], generateAudio: undefined, providerOptions: { C2A: { imageUrls: ["https://canvas.example/first", "https://canvas.example/second"] } }, abortSignal: undefined });
    assert.deepEqual(bodies.at(-1)?.reference_images, [{ url: "https://canvas.example/first" }, { url: "https://canvas.example/second" }]);
    assert.doesNotThrow(() => capability.validateInput!({ generateAudio: true, frameCount: 1 }));
    assert.throws(() => capability.validateInput!({ frameCount: 2 }), /视频接口适配/);
    assert.throws(() => capability.validateInput!({ videos: ["video"] }), /视频.*参考/);
    await assert.rejects(Promise.resolve(model.doStart!({ prompt: "missing URL", n: 1, aspectRatio: undefined, resolution: undefined, duration: undefined, fps: undefined, seed: undefined, image: undefined, frameImages: [{ image, frameType: "first_frame" }], inputReferences: undefined, generateAudio: undefined, providerOptions: {}, abortSignal: undefined })), /签名 URL/);
});
