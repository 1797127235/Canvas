import assert from "node:assert/strict";
import { test } from "node:test";

import { arkImages, arkImageSize } from "../src/ai/gateway-image.js";

const signal = () => new AbortController().signal;

test("clamps panel sizes into the range Ark accepts", () => {
    // 面板的 1k 4:3 与 4k 档位超出方舟的 [921600, 4624220] 像素区间，原样发送会被上游拒绝。
    assert.equal(arkImageSize("1024x768"), "1120x832");
    assert.equal(arkImageSize("3840x2160"), "2864x1600");
    // 已在区间内的尺寸原样保留。
    assert.equal(arkImageSize("2048x2048"), "2048x2048");
    assert.equal(arkImageSize("1536x864"), "1536x864");
    // 非像素值（自动、比例字符串）不自行编造，交给上游默认。
    assert.equal(arkImageSize("auto"), undefined);
    assert.equal(arkImageSize(undefined), undefined);
});

test("sends reference images in the JSON body and reads back base64 results", async t => {
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    t.mock.method(globalThis, "fetch", async (url: URL | string, init: { body: string }) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return Response.json({ data: [{ b64_json: "aGVsbG8=", size: "2864x1600" }] });
    });
    const result = await arkImages({
        baseUrl: "https://ark.example.com/api/v3", apiKey: "key", modelId: "doubao-seedream-5-0-pro-260628",
        prompt: "把裤子换成红色", images: ["data:image/png;base64,aGVsbG8="],
        size: "3840x2160", outputFormat: "png", count: 2, signal: signal(),
    });
    // 方舟一次请求只出一张图，面板的「生成 N 张」按 N 次独立调用展开。
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, "https://ark.example.com/api/v3/images/generations");
    assert.deepEqual(calls[0].body, {
        model: "doubao-seedream-5-0-pro-260628", prompt: "把裤子换成红色",
        image: ["data:image/png;base64,aGVsbG8="], size: "2864x1600",
        output_format: "png", response_format: "b64_json", watermark: false,
    });
    assert.deepEqual(result.data, [
        { b64_json: "aGVsbG8=", mime_type: "image/png" },
        { b64_json: "aGVsbG8=", mime_type: "image/png" },
    ]);
});
