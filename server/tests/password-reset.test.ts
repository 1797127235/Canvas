import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Router } from "express";
import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createLoginRouter } from "../src/identity/login.js";
import { createPasswordResetRouter } from "../src/identity/password-reset.js";
import { createRateLimiter } from "../src/identity/rate-limit.js";
import { createRegisterRouter } from "../src/identity/register.js";
import { createSessionRouter } from "../src/identity/session-routes.js";
import { requestJson, startTestServer, type TestServer } from "./support/http.js";
import { readTestDatabaseUrl } from "./support/database.js";

const database = new Pool({ connectionString: readTestDatabaseUrl(process.env) });
const secret = process.env.RATE_LIMIT_SECRET || "test-only-secret";
const appOrigin = "http://localhost:3000";
const PASSWORD = "Correct!Password123";
const NEW_PASSWORD = "Changed!Password456";
const sent: Array<{ to: string; link: string }> = [];
const mailer = {
    sendPasswordReset: async (to: string, link: string) => {
        sent.push({ to, link });
    },
};
let server: TestServer;
let failNextSend = false;

before(async () => {
    await database.query("DELETE FROM users");
    await database.query("DELETE FROM identity_rate_limits");
    const router = Router();
    const dependencies = { database, rateLimitSecret: secret, secureCookie: false };
    router.use(createRegisterRouter({ ...dependencies, limiter: createRateLimiter(database, "register", secret) }));
    router.use(createLoginRouter({ ...dependencies, limiter: createRateLimiter(database, "login", secret) }));
    router.use(createSessionRouter(database, false));
    router.use(createPasswordResetRouter({
        database,
        appOrigin,
        limiter: createRateLimiter(database, "reset", secret),
        rateLimitSecret: secret,
        mailer: {
            sendPasswordReset: async (to, link) => {
                if (failNextSend) {
                    failNextSend = false;
                    throw new Error("smtp down");
                }
                await mailer.sendPasswordReset(to, link);
            },
        },
    }));
    server = await startTestServer(createApp({ appOrigin, apiRouter: router }));
});

after(async () => {
    await database.query("DELETE FROM users");
    await database.query("DELETE FROM identity_rate_limits");
    await server.close();
    await database.end();
});

test("emails a working reset link and lets the account log in with the new password", async () => {
    const email = await register(`reset-happy-${Date.now()}@example.com`);
    sent.length = 0;
    const requested = await post("/api/password-resets", { email });
    assert.equal(requested.response.status, 204);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, email);
    const token = tokenFrom(sent[0].link);
    assert.equal((await post("/api/password-resets/confirm", { token, password: NEW_PASSWORD })).response.status, 204);
    assert.equal((await login(email, PASSWORD)).response.status, 401);
    assert.equal((await login(email, NEW_PASSWORD)).response.status, 201);
});

test("answers the same way for unknown addresses so the endpoint cannot enumerate accounts", async () => {
    await resetLimits();
    sent.length = 0;
    const unknown = await post("/api/password-resets", { email: `nobody-${Date.now()}@example.com` });
    assert.equal(unknown.response.status, 204);
    // 未注册的地址不应产生任何令牌，也不能因为查不到账号而改变响应。
    assert.equal(sent.length, 0);
    assert.equal((await database.query("SELECT 1 FROM password_reset_tokens WHERE user_id NOT IN (SELECT id FROM users)")).rowCount, 0);
});

test("issues a single-use token and invalidates it after a successful reset", async () => {
    const email = await register(`reset-once-${Date.now()}@example.com`);
    sent.length = 0;
    await post("/api/password-resets", { email });
    const token = tokenFrom(sent[0].link);
    assert.equal((await post("/api/password-resets/confirm", { token, password: NEW_PASSWORD })).response.status, 204);
    assert.equal((await post("/api/password-resets/confirm", { token, password: "Another!Password789" })).response.status, 422);
});

test("replaces an earlier link when a second reset is requested", async () => {
    const email = await register(`reset-replace-${Date.now()}@example.com`);
    sent.length = 0;
    await post("/api/password-resets", { email });
    await post("/api/password-resets", { email });
    const [first, second] = sent.map((item) => tokenFrom(item.link));
    assert.notEqual(first, second);
    assert.equal((await post("/api/password-resets/confirm", { token: first, password: NEW_PASSWORD })).response.status, 422);
    assert.equal((await post("/api/password-resets/confirm", { token: second, password: NEW_PASSWORD })).response.status, 204);
});

test("rejects an expired token", async () => {
    const email = await register(`reset-expired-${Date.now()}@example.com`);
    sent.length = 0;
    await post("/api/password-resets", { email });
    await database.query("UPDATE password_reset_tokens SET expires_at = CURRENT_TIMESTAMP WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email]);
    assert.equal((await post("/api/password-resets/confirm", { token: tokenFrom(sent[0].link), password: NEW_PASSWORD })).response.status, 422);
});

test("revokes existing sessions so the old password's login cannot continue", async () => {
    const email = await register(`reset-sessions-${Date.now()}@example.com`);
    const loggedIn = await login(email, PASSWORD);
    const cookie = cookieFrom(loggedIn);
    assert.equal((await requestJson(server.baseUrl, "/api/session", { headers: { cookie } })).response.status, 200);
    sent.length = 0;
    await post("/api/password-resets", { email });
    await post("/api/password-resets/confirm", { token: tokenFrom(sent[0].link), password: NEW_PASSWORD });
    assert.equal((await requestJson(server.baseUrl, "/api/session", { headers: { cookie } })).response.status, 401);
});

test("clears an active lock so a locked account can recover through the link", async () => {
    const email = await register(`reset-locked-${Date.now()}@example.com`);
    for (let attempt = 0; attempt < 5; attempt += 1) await login(email, "Wrong!Password000");
    assert.equal((await login(email, PASSWORD)).response.status, 429);
    sent.length = 0;
    await post("/api/password-resets", { email });
    assert.equal((await post("/api/password-resets/confirm", { token: tokenFrom(sent[0].link), password: NEW_PASSWORD })).response.status, 204);
    assert.equal((await login(email, NEW_PASSWORD)).response.status, 201);
});

test("drops the token when the mail cannot be sent so the user is not stuck", async () => {
    const email = await register(`reset-mailfail-${Date.now()}@example.com`);
    sent.length = 0;
    failNextSend = true;
    assert.equal((await post("/api/password-resets", { email })).response.status, 502);
    assert.equal(sent.length, 0);
    assert.equal((await database.query("SELECT 1 FROM password_reset_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)", [email])).rowCount, 0);
});

test("reports mail as unconfigured instead of pretending the email was sent", async () => {
    const router = Router();
    router.use(createPasswordResetRouter({
        database,
        appOrigin,
        limiter: createRateLimiter(database, "reset", secret),
        rateLimitSecret: secret,
        mailer: null,
    }));
    const unconfigured = await startTestServer(createApp({ appOrigin, apiRouter: router }));
    const response = await requestJson(unconfigured.baseUrl, "/api/password-resets", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify({ email: `anyone-${Date.now()}@example.com` }),
    });
    await unconfigured.close();
    assert.equal(response.response.status, 503);
});

async function register(email: string) {
    await resetLimits();
    const created = await post("/api/users", { email, password: PASSWORD });
    assert.equal(created.response.status, 201);
    return email;
}

// 限流按来源地址计数，测试全都来自 127.0.0.1；逐用例清空以免互相吃掉额度。
async function resetLimits() {
    await database.query("DELETE FROM identity_rate_limits");
}

function post(path: string, body: unknown) {
    return requestJson(server.baseUrl, path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify(body),
    });
}

function login(email: string, password: string) {
    return post("/api/sessions", { email, password });
}

function tokenFrom(link: string) {
    const token = new URL(link).searchParams.get("token");
    assert.ok(token);
    return token;
}

function cookieFrom(result: { response: Response }) {
    return (result.response.headers.get("set-cookie") || "").split(";")[0];
}
