import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { test } from "node:test";
import express from "express";
import { createImages, createVideo, mediaReader, readVideo } from "../src/ai/generation.js";
import { downloadGatewayVideo } from "../src/ai/gateway-video.js";
import { accountModels, publicModels, type CatalogModel } from "../src/catalog/catalog.js";
import { startTestServer } from "./support/http.js";

const image = "data:image/png;base64,aGVsbG8=";
const video = "data:video/mp4;base64,aGVsbG8=";
const audio = "data:audio/mpeg;base64,aGVsbG8=";
const imageId = "11111111-1111-1111-1111-111111111111";
const videoId = "22222222-2222-2222-2222-222222222222";
const audioId = "33333333-3333-3333-3333-333333333333";
const ref = (id: string) => `remote:${id}`;
const signal = () => new AbortController().signal;

// 生成入参现在只传身份，字节由服务端按 id 读取；测试用固定表代替 user_media。
function stubMedia(entries: Record<string, { bytes: Buffer; mimeType: string }>) {
    return mediaReader(async (mediaId) => {
        const found = entries[mediaId];
        if (!found) throw new Error("参考素材不存在或不属于当前账号");
        return found;
    });
}
const media = stubMedia({
    [imageId]: { bytes: Buffer.from("hello"), mimeType: "image/png" },
    [videoId]: { bytes: Buffer.from("hello"), mimeType: "video/mp4" },
    [audioId]: { bytes: Buffer.from("hello"), mimeType: "audio/mpeg" },
});

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
        const images = await createImages(model("grok-imagine-image-2.0", "xai-images", "image"), "account-key", { prompt: "image", n: 1, size: "1024x1024" }, signal(), media);
        assert.equal(images.data[0].mime_type, "image/jpeg");
        assert.equal(calls.at(-1)?.path, "/v1/images/generations");
        assert.equal(calls.at(-1)?.body.aspect_ratio, "1:1");

        const frames = await createVideo(h3, "account-key", { prompt: "frames", mode: "frames", images: [ref(imageId), ref(imageId)], seconds: "5", resolution_name: "768p" }, signal(), media);
        // MiniMax-H3 登记的是 [OI] Videos：时长发 seconds，多张参考图走 images 字符串数组。
        assert.deepEqual(calls.at(-1)?.body.images, [image, image]);
        assert.equal(calls.at(-1)?.body.seconds, 5);
        assert.equal(calls.at(-1)?.body.resolution, "768p");
        assert.equal(calls.at(-1)?.body.duration, undefined);

        await createVideo(h3, "account-key", { prompt: "reference", mode: "reference", images: [ref(imageId), ref(imageId)], videos: [ref(videoId)], audios: [ref(audioId)] }, signal(), media);
        assert.deepEqual(calls.at(-1)?.body.images, [image, image]);
        assert.deepEqual(calls.at(-1)?.body.videos, [{ url: video }]);
        assert.deepEqual(calls.at(-1)?.body.audios, [{ url: audio }]);
        assert.equal(calls.at(-1)?.body.input_reference, undefined);
        // 单张参考图走该入口的 input_reference 字段。
        await createVideo(h3, "account-key", { prompt: "single", mode: "reference", images: [ref(imageId)] }, signal(), media);
        assert.deepEqual(calls.at(-1)?.body.input_reference, { image_url: image });
        const resumed = await readVideo(JSON.parse(JSON.stringify(frames.operation)), h3.baseUrl, "account-key", signal());
        assert.equal(resumed.status, "completed");

        const created = await createVideo(grok, "account-key", { prompt: "grok", mode: "reference", images: [ref(imageId)], seconds: "5", resolution_name: "720p" }, signal(), media);
        assert.equal(calls.at(-1)?.path, "/v1/videos/generations");
        assert.deepEqual(calls.at(-1)?.body.reference_images, [{ url: image }]);
        const state = await readVideo(JSON.parse(JSON.stringify(created.operation)), grok.baseUrl, "account-key", signal());
        assert.equal(state.status, "completed");
        if (state.status !== "completed" || state.videos[0].type !== "url") throw new Error("Missing video URL");
        // 现在返回流（不再在 api 进程里整块持有视频），测试读成字符串比较。
        const stream = await downloadGatewayVideo(state.videos[0].url, grok.baseUrl, "account-key", signal());
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        assert.equal(Buffer.concat(chunks).toString(), "video-content");
        assert.equal(calls.at(-1)?.authorization, "Bearer account-key");
        const count = calls.length;
        // 非当前网关的地址不再直接放行给账号 Key：校验不通过（或不可解析）时拒绝下载。
        await assert.rejects(downloadGatewayVideo("https://other.invalid/video.mp4", grok.baseUrl, "account-key", signal()), /不安全的视频地址/);
        await assert.rejects(createVideo(grok, "account-key", { prompt: "reference", videos: [ref(videoId)] }, signal(), media), /不支持参考视频/);
        assert.equal(calls.length, count);
        await assert.rejects(createVideo(h3, "account-key", { prompt: "fail" }, signal(), media), /temporary failure/);
        assert.equal(calls.length, count + 1);
        // 上游网关返回 HTML 错误页时不能把页面当错误信息丢给用户，只留状态码结论。
        await assert.rejects(createVideo(h3, "account-key", { prompt: "gateway-down" }, signal(), media), /上游服务暂时不可用/);
        assert.equal(calls.length, count + 2);
    } finally { await upstream.close(); }
});

test("多张视频参考图按总大小压缩，避免三张中等图片合计超过上游限制", async () => {
    const calls: Array<{ body: Record<string, any> }> = [];
    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.post("/v1/videos/generations", (request, response) => {
        calls.push({ body: request.body });
        response.json({ request_id: "compressed" });
    });
    const upstream = await startTestServer(app);
    try {
        await createVideo({
            id: "grok", name: "Grok", upstreamModel: "grok-imagine-video-1.5", adapter: "xai-videos", capability: "video", enabled: true, baseUrl: `${upstream.baseUrl}/v1`,
        }, "account-key", { prompt: "三张参考图", mode: "reference", images: [ref(imageId), ref(videoId), ref(audioId)] }, signal(), stubMedia({
            [imageId]: { bytes: png(960, 1280), mimeType: "image/png" },
            [videoId]: { bytes: png(960, 1280), mimeType: "image/png" },
            [audioId]: { bytes: png(960, 1280), mimeType: "image/png" },
        }));
        const images = calls[0].body.reference_images as Array<{ url: string }>;
        const total = images.reduce((sum, item) => sum + Buffer.from(item.url.slice(item.url.indexOf(",") + 1), "base64").length, 0);
        assert.equal(images.length, 3);
        assert.ok(total <= 700 * 1024, `compressed total ${total}`);
    } finally { await upstream.close(); }
});

function png(width: number, height: number) {
    const raw = Buffer.alloc(height * (1 + width * 3));
    for (let y = 0; y < height; y += 1) {
        const offset = y * (1 + width * 3);
        for (let x = 0; x < width; x += 1) {
            const pixel = offset + 1 + x * 3;
            raw[pixel] = (x * 13 + y * 7) % 256; raw[pixel + 1] = (x * 3 + y * 11) % 256; raw[pixel + 2] = (x + y * 5) % 256;
        }
    }
    const compressed = deflateSync(raw);
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type), data]);
        const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
        const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(value: Buffer) {
    let crc = 0xffffffff;
    for (const byte of value) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

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
