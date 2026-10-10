import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { requestJson, startTestServer } from "./support/http.js";

test("returns a generic JSON error without exposing internal details", async () => {
    const testServer = await startTestServer(createApp({ appOrigin: "http://localhost:3000" }));
    try {
        const result = await requestJson<{ error: { code: string; message: string } }>(testServer.baseUrl, "/missing");
        assert.equal(result.response.headers.get("cache-control"), "no-store");
        assert.deepEqual(result.body, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        assert.doesNotMatch(JSON.stringify(result.body), /stack|sql|password|secret/i);
    } finally {
        await testServer.close();
    }
});
