import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Router } from "express";
import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createLoginRouter } from "../src/identity/login.js";
import { createRegisterRouter } from "../src/identity/register.js";
import { createSessionRouter } from "../src/identity/session-routes.js";
import { requireUser } from "../src/identity/auth-middleware.js";
import { clearExpiredIdentityData } from "../src/identity/cleanup.js";
import { createRateLimiter } from "../src/identity/rate-limit.js";
import { requestJson, startTestServer, type TestServer } from "./support/http.js";
import { readTestDatabaseUrl } from "./support/database.js";

const database = new Pool({ connectionString: readTestDatabaseUrl(process.env) });
const secret = process.env.RATE_LIMIT_SECRET || "test-only-secret";
const appOrigin = "http://localhost:3000";
const createdUserIds: string[] = [];
let server: TestServer;

before(async () => {
    await database.query("DELETE FROM users");
    await database.query("DELETE FROM identity_rate_limits");
    const router = Router();
    router.use(createRegisterRouter({ database, limiter: createRateLimiter(database, "register", secret), rateLimitSecret: secret, secureCookie: false }));
    router.use(createLoginRouter({ database, limiter: createRateLimiter(database, "login", secret), rateLimitSecret: secret, secureCookie: false }));
    router.use(createSessionRouter(database, false));
    router.get("/private", requireUser(database), (_request, response) => response.json(response.locals.user));
    server = await startTestServer(createApp({ appOrigin, apiRouter: router }));
});

after(async () => {
    await database.query("DELETE FROM users");
    await database.query("DELETE FROM identity_rate_limits");
    await server.close();
    await database.end();
});

async function register(email: string) {
    const result = await requestJson<{ user: { id: string }; expiresAt: string }>(server.baseUrl, "/api/users", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify({ email, password: "Correct!Password123" }),
    });
    createdUserIds.push(result.body!.user.id);
    return result;
}

function cookieFrom(result: { response: Response }) {
    return result.response.headers.get("set-cookie")!.split(";", 1)[0];
}

test("reads the current session and does not extend its expiry", async () => {
    const registered = await register(`session-api-${Date.now()}@example.com`);
    const cookie = cookieFrom(registered);
    const current = await requestJson<{ user: { id: string; email: string }; expiresAt: string }>(server.baseUrl, "/api/session", { headers: { cookie } });
    assert.equal(current.response.status, 200);
    assert.equal(current.body?.user.id, registered.body?.user.id);
    assert.equal(typeof current.body?.user.email, "string");
    assert.equal(current.body?.expiresAt, registered.body?.expiresAt);
});

test("derives private user identity only from an active server session", async () => {
    const registered = await register(`private-api-${Date.now()}@example.com`);
    const cookie = cookieFrom(registered);
    const current = await requestJson<{ id: string }>(server.baseUrl, "/api/private?userId=forged", { headers: { cookie, "x-user-id": "forged" } });
    assert.equal(current.response.status, 200);
    assert.equal(current.body?.id, registered.body?.user.id);
    await database.query("UPDATE sessions SET expires_at = CURRENT_TIMESTAMP WHERE user_id = $1", [registered.body?.user.id]);
    assert.equal((await requestJson(server.baseUrl, "/api/private", { headers: { cookie } })).response.status, 401);
});

test("cleans only expired sessions and source windows without deleting accounts", async () => {
    const registered = await register(`cleanup-api-${Date.now()}@example.com`);
    const active = await register(`cleanup-active-${Date.now()}@example.com`);
    await database.query("UPDATE sessions SET expires_at = CURRENT_TIMESTAMP WHERE user_id = $1", [registered.body?.user.id]);
    await database.query("INSERT INTO identity_rate_limits (key, points, expire) VALUES ($1, 1, $2), ($3, 1, $4)", ["cleanup-expired", Date.now() - 1000, "cleanup-active", Date.now() + 60000]);
    await clearExpiredIdentityData(database);
    assert.equal((await requestJson(server.baseUrl, "/api/session", { headers: { cookie: cookieFrom(active) } })).response.status, 200);
    assert.equal((await database.query("SELECT id FROM users WHERE id = $1", [registered.body?.user.id])).rowCount, 1);
    assert.equal((await database.query("SELECT 1 FROM sessions WHERE user_id = $1", [registered.body?.user.id])).rowCount, 0);
    assert.equal((await database.query("SELECT 1 FROM identity_rate_limits WHERE key = 'cleanup-expired'")).rowCount, 0);
    assert.equal((await database.query("SELECT 1 FROM identity_rate_limits WHERE key = 'cleanup-active'")).rowCount, 1);
});

test("logout revokes only the current session and is idempotent", async () => {
    const registered = await register(`session-logout-${Date.now()}@example.com`);
    const cookie = cookieFrom(registered);
    const logout = await requestJson<null>(server.baseUrl, "/api/session", { method: "DELETE", headers: { origin: appOrigin, cookie } });
    assert.equal(logout.response.status, 204);
    assert.match(logout.response.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal((await requestJson(server.baseUrl, "/api/session", { headers: { cookie } })).response.status, 401);
    assert.equal((await requestJson(server.baseUrl, "/api/session", { method: "DELETE", headers: { origin: appOrigin } })).response.status, 204);
});

test("keeps another device session valid after logging out the first", async () => {
    const email = `session-devices-${Date.now()}@example.com`;
    const first = await register(email);
    const second = await requestJson<{ user: { id: string }; expiresAt: string }>(server.baseUrl, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify({ email, password: "Correct!Password123" }),
    });
    assert.equal(second.response.status, 201);
    const firstCookie = cookieFrom(first);
    const secondCookie = cookieFrom(second);
    assert.notEqual(firstCookie, secondCookie);
    await requestJson(server.baseUrl, "/api/session", { method: "DELETE", headers: { origin: appOrigin, cookie: firstCookie } });
    assert.equal((await requestJson(server.baseUrl, "/api/session", { headers: { cookie: secondCookie } })).response.status, 200);
});
