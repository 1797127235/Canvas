import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createRegisterRouter } from "../src/identity/register.js";
import { createRateLimiter } from "../src/identity/rate-limit.js";
import { requestJson, startTestServer, type TestServer } from "./support/http.js";
import { readTestDatabaseUrl } from "./support/database.js";

const database = new Pool({ connectionString: readTestDatabaseUrl(process.env) });
const secret = process.env.RATE_LIMIT_SECRET || "test-only-secret";
const limiter = createRateLimiter(database, "register", secret);
const createdEmails: string[] = [];
const appOrigin = "http://localhost:3000";
let server: TestServer;

before(async () => {
    await database.query("DELETE FROM identity_rate_limits");
    server = await startTestServer(
        createApp({
            appOrigin,
            apiRouter: createRegisterRouter({ database, limiter, rateLimitSecret: secret, secureCookie: false }),
        }),
    );
});

after(async () => {
    for (const email of createdEmails) await database.query("DELETE FROM users WHERE email = $1", [email]);
    await database.query("DELETE FROM identity_rate_limits");
    await server.close();
    await database.end();
});

function register(email: string, password = "Correct!Password123") {
    createdEmails.push(email.toLowerCase());
    return requestJson<{ user: { id: string; email: string }; expiresAt: string } | { error: { code: string } }>(server.baseUrl, "/api/users", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify({ email, password }),
    });
}

test("registers an account and creates a fixed session cookie", async () => {
    const email = `register-${Date.now()}@example.com`;
    const result = await register(`  ${email.toUpperCase()}  `);
    assert.equal(result.response.status, 201);
    assert.equal((result.body as { user: { email: string } }).user.email, email);
    assert.match(result.response.headers.get("set-cookie") || "", /infinite_canvas_session=/);
    assert.match(result.response.headers.get("set-cookie") || "", /HttpOnly/);
    assert.match(result.response.headers.get("set-cookie") || "", /SameSite=Lax/);
    assert.doesNotMatch(JSON.stringify(result.body), /Correct!Password123|password_hash|session/i);
});

test("rejects duplicate normalized email without changing the first account", async () => {
    const email = `duplicate-${Date.now()}@example.com`;
    const first = await register(email);
    const second = await register(` ${email.toUpperCase()} `);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 409);
    assert.deepEqual(second.body, { error: { code: "EMAIL_EXISTS", message: "该邮箱已注册，请登录" } });
});

test("rejects invalid input before creating an account", async () => {
    const result = await register(`invalid-${Date.now()}@example.com`, "中文密码");
    assert.equal(result.response.status, 422);
    assert.deepEqual(result.body, { error: { code: "VALIDATION_ERROR", message: "邮箱或密码格式无效" } });
});

test("allows only one concurrent registration for the same normalized email", async () => {
    const email = `concurrent-${Date.now()}@example.com`;
    const results = await Promise.all([register(email), register(` ${email.toUpperCase()} `)]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
});
