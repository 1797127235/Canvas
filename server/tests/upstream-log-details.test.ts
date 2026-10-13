import assert from "node:assert/strict";
import { test } from "node:test";

import { upstreamLogDetails } from "../src/generation.js";

test("上游错误详情提取状态码、URL 与响应体，并脱敏账号 Key", () => {
    const key = "sk-live-account-key-123";
    const details = upstreamLogDetails(
        Object.assign(new Error("Invalid JSON response"), {
            statusCode: 502,
            url: `https://upstream.example/v1/images/generations?key=${key}`,
            responseBody: `<html>${key} gateway timeout page</html>`.repeat(100),
            text: `plain text ${key}`,
            data: { nested: "object-ignored" },
        }),
        key,
    );
    assert.equal(details?.status, 502);
    assert.equal(details?.url, "https://upstream.example/v1/images/generations?key=[已隐藏]");
    const body = details?.responseBody as string;
    assert.ok(body.includes("[已隐藏]"));
    assert.ok(body.includes("[truncated"));
    assert.ok(!body.includes(key));
    assert.equal(details?.text, "plain text [已隐藏]");
    assert.equal(details?.data, '{"nested":"object-ignored"}');
    assert.equal(upstreamLogDetails(new Error("plain"), "sk-x"), undefined);
});
