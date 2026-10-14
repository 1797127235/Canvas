import assert from "node:assert/strict";
import { test } from "node:test";
import { APICallError } from "ai";

import { generationErrorMessage } from "../src/generation.js";

const upstreamError = (message: string, statusCode: number) => new APICallError({
    message, url: "https://upstream.example/v1/videos", requestBodyValues: undefined,
    statusCode, responseBody: JSON.stringify({ error: { message } }), isRetryable: false,
});

test("上游视频并发不足换成可读提示", () => {
    const message = generationErrorMessage(upstreamError("No eligible video account or concurrency slot is available", 503));
    assert.equal(message, "上游服务繁忙，请稍后重试");
});

test("时长超出模型能力时提示调整时长，不回显上游原文", () => {
    const message = generationErrorMessage(upstreamError(
        'model "seedance-2.0-fast-offical" does not support this request: parameter "duration_seconds" is outside the selected model route\'s capability (request id: 202610140200552137518008268d9d6ZBVgUhb1)', 400,
    ));
    assert.equal(message, "该模型不支持所选视频时长，请调整时长后重试");
});

test("自己写的中文提示原样保留", () => {
    assert.equal(
        generationErrorMessage(new Error("Grok 当前不支持参考视频生成，请改用 MiniMax-H3；Grok 可使用图片参考或视频编辑接口")),
        "Grok 当前不支持参考视频生成，请改用 MiniMax-H3；Grok 可使用图片参考或视频编辑接口",
    );
});

test("超时、认证、限流和数据库异常都不泄露原文", () => {
    assert.equal(generationErrorMessage(new Error("The operation was aborted due to timeout")), "生成超时，请稍后重试");
    assert.equal(generationErrorMessage(upstreamError("invalid api key", 401)), "账号 API Key 无效或已过期，请重新保存后重试");
    assert.equal(generationErrorMessage(upstreamError("rate limit exceeded", 429)), "请求过于频繁，请稍后重试");
    assert.equal(generationErrorMessage(new Error('column "upstream_id" of relation "user_generation_tasks" does not exist')), "生成失败，请稍后重试");
    assert.equal(generationErrorMessage(undefined), "生成失败，请稍后重试");
});

test("视频任务状态里的字符串错误同样处理", () => {
    assert.equal(generationErrorMessage("The operation was aborted due to timeout"), "生成超时，请稍后重试");
    assert.equal(generationErrorMessage("视频生成超时，请稍后重试"), "视频生成超时，请稍后重试");
});
