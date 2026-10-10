import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../src/app.js";
import { requestJson, startTestServer } from "./support/http.js";

const appOrigin = "http://localhost:3000";

test("rejects state changes without a same-origin source", async () => {
    const server = await startTestServer(createApp({ appOrigin }));
    try {
        const sources: Array<Record<string, string>> = [{}, { origin: "https://evil.example" }, { referer: "https://evil.example/form" }];
        for (const headers of sources) {
            const result = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ email: "person@example.com", password: "password" }),
            });
            assert.equal(result.response.status, 403);
            assert.equal(result.body?.error.code, "FORBIDDEN");
        }
    } finally {
        await server.close();
    }
});

test("accepts a same-origin source and reports the missing route without caching", async () => {
    const server = await startTestServer(createApp({ appOrigin }));
    try {
        const result = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
            method: "POST",
            headers: { "content-type": "application/json", origin: appOrigin },
            body: JSON.stringify({ email: "person@example.com", password: "password" }),
        });
        assert.equal(result.response.status, 404);
        assert.equal(result.body?.error.code, "NOT_FOUND");
        assert.equal(result.response.headers.get("cache-control"), "no-store");
    } finally {
        await server.close();
    }
});

test("rejects invalid JSON, unsupported encoding, and oversized identity bodies", async () => {
    const server = await startTestServer(createApp({ appOrigin }));
    try {
        const invalidJson = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
            method: "POST",
            headers: { "content-type": "application/json", origin: appOrigin },
            body: "{",
        });
        assert.equal(invalidJson.response.status, 400);
        assert.equal(invalidJson.body?.error.code, "INVALID_REQUEST");

        const unsupportedEncoding = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
            method: "POST",
            headers: { "content-encoding": "gzip", "content-type": "application/json", origin: appOrigin },
            body: "{}",
        });
        assert.equal(unsupportedEncoding.response.status, 415);
        assert.equal(unsupportedEncoding.body?.error.code, "UNSUPPORTED_MEDIA_TYPE");

        const oversized = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
            method: "POST",
            headers: { "content-type": "application/json", origin: appOrigin },
            body: JSON.stringify({ value: "x".repeat(5000) }),
        });
        assert.equal(oversized.response.status, 413);
        assert.equal(oversized.body?.error.code, "PAYLOAD_TOO_LARGE");
    } finally {
        await server.close();
    }
});

test("rejects non-JSON bodies on identity POST routes", async () => {
    const server = await startTestServer(createApp({ appOrigin }));
    try {
        const result = await requestJson<{ error: { code: string } }>(server.baseUrl, "/api/users", {
            method: "POST",
            headers: { "content-type": "text/plain", origin: appOrigin },
            body: "email=person@example.com",
        });
        assert.equal(result.response.status, 415);
        assert.equal(result.body?.error.code, "UNSUPPORTED_MEDIA_TYPE");
    } finally {
        await server.close();
    }
});
