import assert from "node:assert/strict";
import { test } from "node:test";

import { Router } from "express";
import type { Pool } from "pg";
import type { RateLimiterPostgres } from "rate-limiter-flexible";

import { createApp } from "../src/app.js";
import { createLoginRouter } from "../src/identity/login.js";
import { createRegisterRouter } from "../src/identity/register.js";
import { createSessionRouter } from "../src/identity/session-routes.js";
import { requireUser } from "../src/identity/auth-middleware.js";
import { requestJson, startTestServer } from "./support/http.js";

const origin = "http://localhost:3000";
const database = { query: async () => { throw new Error("private database credentials"); }, connect: async () => { throw new Error("private database credentials"); } } as unknown as Pool;
const limiter = { consume: async () => undefined } as unknown as RateLimiterPostgres;

function routes() {
    const router = Router();
    const dependencies = { database, limiter, rateLimitSecret: "test-secret", secureCookie: false };
    router.use(createLoginRouter(dependencies), createRegisterRouter(dependencies), createSessionRouter(database, false));
    router.get("/private", requireUser(database), (_request, response) => response.json(response.locals.user));
    return router;
}

test("returns sanitized JSON errors for asynchronous identity database failures", async () => {
    const server = await startTestServer(createApp({ appOrigin: origin, apiRouter: routes() }));
    try {
        const cookie = `infinite_canvas_session=${Buffer.alloc(32, 1).toString("base64url")}`;
        for (const [method, path] of [["POST", "/api/users"], ["POST", "/api/sessions"], ["GET", "/api/session"], ["DELETE", "/api/session"], ["GET", "/api/private"]]) {
            const result = await requestJson(server.baseUrl, path, {
                method, headers: { origin, cookie, "content-type": "application/json" },
                ...(method === "POST" ? { body: JSON.stringify({ email: "person@example.com", password: "Correct!Password123" }) } : {}),
            });
            assert.equal(result.response.status, 500);
            assert.deepEqual(result.body, { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
            assert.equal(result.response.headers.get("set-cookie"), null);
        }
    } finally { await server.close(); }
});

test("rejects non-JSON requests before mounted auth handlers and does not trust a client userId", async () => {
    const server = await startTestServer(createApp({ appOrigin: origin, apiRouter: routes() }));
    try {
        for (const path of ["/api/users", "/api/sessions"]) {
            const result = await requestJson(server.baseUrl, path, { method: "POST", headers: { origin, "content-type": "text/plain" }, body: "{}" });
            assert.equal(result.response.status, 415);
        }
        const result = await requestJson(server.baseUrl, "/api/private?userId=someone-else", { headers: { "x-user-id": "someone-else" } });
        assert.equal(result.response.status, 401);
    } finally { await server.close(); }
});
