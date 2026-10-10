import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { requestJson, startTestServer } from "./support/http.js";

test("starts an isolated HTTP server on a loopback ephemeral port", async () => {
    const testServer = await startTestServer(createApp({ appOrigin: "http://localhost:3000" }));
    try {
        const result = await requestJson<{ error: { code: string } }>(testServer.baseUrl, "/missing");
        assert.equal(result.response.status, 404);
        assert.deepEqual(result.body, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } finally {
        await testServer.close();
    }
});

test("closes an already closed test server safely", async () => {
    const testServer = await startTestServer(createApp({ appOrigin: "http://localhost:3000" }));
    await testServer.close();
    await testServer.close();
});
