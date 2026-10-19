import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModel } from "../src/gateway/index.js";
import { gatewayFetch, gatewayJson } from "../src/gateway/transport.js";

test("base registry rejects unregistered providers and mismatched capabilities", () => {
    assert.throws(() => chatModel({ providerId: "unregistered", capability: "text", upstreamModel: "opaque", baseUrl: "https://provider.example/v1" }, "key"), /未注册的提供商/);
});

test("common transport rejects unsafe URLs and never retries failed creation", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
        calls++;
        assert.equal(init.redirect, "error");
        return new Response("<html>unavailable</html>", { status: 503 });
    });
    await assert.rejects(async () => gatewayFetch("file:///tmp/result"), /地址无效/);
    assert.equal(calls, 0);
    await assert.rejects(gatewayJson("https://provider.example/v1/tasks", "key", { prompt: "test" }), /暂时不可用/);
    assert.equal(calls, 1);
});
