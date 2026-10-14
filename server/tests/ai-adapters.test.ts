import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createImages, createVideo, readVideo } from "../src/ai/generation.js";
import { downloadGatewayVideo } from "../src/ai/gateway-video.js";
import { accountModels, publicModels, type CatalogModel } from "../src/catalog/catalog.js";
import { startTestServer } from "./support/http.js";

const image = "data:image/png;base64,aGVsbG8=";
const video = "data:video/mp4;base64,aGVsbG8=";
const audio = "data:audio/mpeg;base64,aGVsbG8=";
const signal = () => new AbortController().signal;

test("SDK providers map Grok and H3 media roles, resume serialized operations and never retry paid requests", async () => {
    const calls: Array<{ path: string; body: Record<string, any>; authorization?: string }> = [];
    const app = express();
    app.use(express.json());
    app.use((request, response) => {
        const body = request.body || {};
        calls.push({ path: request.path, body, authorization: request.header("authorization") });
        if (body.prompt === "fail") return response.status(503).json({ error: { message: "temporary failure" } });
        if (body.prompt === "gateway-down") return response.status(502).type("html").send("<!DOCTYPE html><title>codex2api.com | 502: Bad gateway</title>");
        if (request.path === "/v1/images/generations") return response.json({ data: [{ b64_json: "/9j/AA==" }] });
        if (request.path.endsWith("/content")) return response.type("video/mp4").send(Buffer.from("video-content"));
        if (request.path === "/v1/videos/generations") return response.json({ request_id: "grok-task" });
        if (request.path === "/v1/videos/grok-task") return response.json({ status: "done", video: { url: "/v1/videos/grok-task/content" } });
        if (request.path === "/v1/videos") return response.json({ id: "h3-task", status: "queued" });
        if (request.path === "/v1/videos/h3-task") return response.json({ id: "h3-task", status: "completed" });
        return response.status(404).end();
    });
    const upstream = await startTestServer(app);
    const model = (id: string, adapter: CatalogModel["adapter"], capability: CatalogModel["capability"] = "video"): CatalogModel => ({
        id, name: id, upstreamModel: id, adapter, capability, enabled: true, baseUrl: `${upstream.baseUrl}/v1`,
    });
    const h3 = model("MiniMax-H3", "gateway-videos");
    const grok = model("grok-imagine-video-1.5", "xai-videos");
    try {
        const images = await createImages(model("grok-imagine-image-2.0", "xai-images", "image"), "account-key", { prompt: "image", n: 1, size: "1024x1024" }, signal());
        assert.equal(images.data[0].mime_type, "image/jpeg");
        assert.equal(calls.at(-1)?.path, "/v1/images/generations");
        assert.equal(calls.at(-1)?.body.aspect_ratio, "1:1");

        const frames = await createVideo(h3, "account-key", { prompt: "frames", mode: "frames", images: [image, image], seconds: "5", resolution_name: "768p" }, signal());
        assert.deepEqual(calls.at(-1)?.body.image, { url: image });
        assert.deepEqual(calls.at(-1)?.body.last_frame, { url: image });
        assert.equal(calls.at(-1)?.body.duration, 5);
        assert.equal(calls.at(-1)?.body.resolution, "768p");

        await createVideo(h3, "account-key", { prompt: "reference", mode: "reference", images: [image, image], videos: [video], audios: [audio] }, signal());
        assert.deepEqual(calls.at(-1)?.body.reference_images, [{ url: image }, { url: image }]);
        assert.deepEqual(calls.at(-1)?.body.videos, [{ url: video }]);
        assert.deepEqual(calls.at(-1)?.body.audios, [{ url: audio }]);
        assert.equal(calls.at(-1)?.body.image, undefined);
        const resumed = await readVideo(JSON.parse(JSON.stringify(frames.operation)), h3.baseUrl, "account-key", signal());
        assert.equal(resumed.status, "completed");

        const created = await createVideo(grok, "account-key", { prompt: "grok", mode: "reference", images: [image], seconds: "5", resolution_name: "720p" }, signal());
        assert.equal(calls.at(-1)?.path, "/v1/videos/generations");
        assert.deepEqual(calls.at(-1)?.body.reference_images, [{ url: image }]);
        const state = await readVideo(JSON.parse(JSON.stringify(created.operation)), grok.baseUrl, "account-key", signal());
        assert.equal(state.status, "completed");
        if (state.status !== "completed" || state.videos[0].type !== "url") throw new Error("Missing video URL");
        assert.equal((await downloadGatewayVideo(state.videos[0].url, grok.baseUrl, "account-key", signal())).toString(), "video-content");
        assert.equal(calls.at(-1)?.authorization, "Bearer account-key");
        const count = calls.length;
        await assert.rejects(downloadGatewayVideo("https://other.invalid/video.mp4", grok.baseUrl, "account-key", signal()), /非当前网关/);
        await assert.rejects(createVideo(grok, "account-key", { prompt: "reference", videos: [video] }, signal()), /不支持参考视频/);
        assert.equal(calls.length, count);
        await assert.rejects(createVideo(h3, "account-key", { prompt: "fail" }, signal()), /temporary failure/);
        assert.equal(calls.length, count + 1);
        // 上游网关返回 HTML 错误页时不能把页面当错误信息丢给用户，只留状态码结论。
        await assert.rejects(createVideo(h3, "account-key", { prompt: "gateway-down" }, signal()), /上游服务暂时不可用/);
        assert.equal(calls.length, count + 2);
    } finally { await upstream.close(); }
});

test("model discovery selects SDK providers and keeps unavailable H3-Max disabled unless explicitly enabled", async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
        { id: "grok-imagine-image-2.0" }, { id: "grok-imagine-video-1.5" }, { id: "MiniMax-H3" }, { id: "MiniMax-H3-Max" },
    ] }));
    const catalog = { models: [
        { id: "image", name: "Image", upstreamModel: "gpt-image-2.5", adapter: "openai-images" as const, capability: "image" as const, enabled: true, baseUrl: "https://gateway.example/v1" },
        { id: "MiniMax-H3-Max", name: "MiniMax H3 Max", upstreamModel: "MiniMax-H3-Max", adapter: "gateway-videos" as const, capability: "video" as const, enabled: false, baseUrl: "https://gateway.example/v1" },
    ] };
    const models = await accountModels(catalog, "account-key");
    assert.deepEqual(models.map(model => model.adapter), ["xai-images", "xai-videos", "gateway-videos", "gateway-videos"]);
    assert.equal(publicModels({ models }).length, 3);
    const explicitlyEnabled = await accountModels({ models: catalog.models.map(model => ({ ...model, enabled: true })) }, "account-key");
    assert.equal(publicModels({ models: explicitlyEnabled }).length, 4);
});
