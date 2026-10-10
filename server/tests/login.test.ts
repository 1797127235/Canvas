import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { Router } from "express";
import { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createLoginRouter } from "../src/identity/login.js";
import { createRegisterRouter } from "../src/identity/register.js";
import { createRateLimiter } from "../src/identity/rate-limit.js";
import { createAccount } from "../src/identity/account-repository.js";
import { hashPassword } from "../src/identity/passwords.js";
import { requestJson, startTestServer, type TestServer } from "./support/http.js";
import { readTestDatabaseUrl } from "./support/database.js";

const database = new Pool({ connectionString: readTestDatabaseUrl(process.env) });
const secret = process.env.RATE_LIMIT_SECRET || "test-only-secret";
const appOrigin = "http://localhost:3000";
const loginLimiter = createRateLimiter(database, "login", secret);
const registerLimiter = createRateLimiter(database, "register", secret);
const createdUserIds: string[] = [];
let server: TestServer;

before(async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const router = Router();
    router.use(createRegisterRouter({ database, limiter: registerLimiter, rateLimitSecret: secret, secureCookie: false }));
    router.use(createLoginRouter({ database, limiter: loginLimiter, rateLimitSecret: secret, secureCookie: false }));
    server = await startTestServer(createApp({ appOrigin, apiRouter: router }));
});

after(async () => {
    await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [createdUserIds]);
    await database.query("DELETE FROM identity_rate_limits");
    await server.close();
    await database.end();
});

async function createTestUser(email: string) {
    const account = await createAccount(database, email, await hashPassword("Correct!Password123"));
    createdUserIds.push(account.id);
    return account;
}

function login(email: string, password = "Correct!Password123") {
    return requestJson<{ user: { id: string; email: string }; expiresAt: string } | { error: { code: string; message: string } }>(server.baseUrl, "/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", origin: appOrigin },
        body: JSON.stringify({ email, password }),
    });
}

test("uses the same generic error for unknown and wrong credentials", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-error-${Date.now()}@example.com`);
    const unknown = await login(`unknown-${Date.now()}@example.com`);
    const wrong = await login(account.email, "Wrong!Password123");
    assert.equal(unknown.response.status, 401);
    assert.equal(wrong.response.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
});

test("locks after five failures, rejects correct credentials while locked, then clears on success", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-lock-${Date.now()}@example.com`);
    for (let index = 0; index < 5; index += 1) assert.equal((await login(account.email, "Wrong!Password123")).response.status, 401);
    assert.equal((await login(account.email)).response.status, 429);

    await database.query("UPDATE users SET locked_until = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [account.id]);
    assert.equal((await login(account.email)).response.status, 201);
    const row = await database.query<{ failed_login_attempts: number; locked_until: Date | null }>("SELECT failed_login_attempts, locked_until FROM users WHERE id = $1", [account.id]);
    assert.equal(row.rows[0].failed_login_attempts, 0);
    assert.equal(row.rows[0].locked_until, null);
});

test("does not extend an active lock on repeated attempts", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-repeat-lock-${Date.now()}@example.com`);
    await database.query("UPDATE users SET failed_login_attempts = 5, locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes' WHERE id = $1", [account.id]);
    const before = await database.query("SELECT locked_until FROM users WHERE id = $1", [account.id]);
    assert.equal((await login(account.email, "Wrong!Password123")).response.status, 429);
    assert.equal((await login(account.email)).response.status, 429);
    const after = await database.query("SELECT locked_until FROM users WHERE id = $1", [account.id]);
    assert.equal(after.rows[0].locked_until.getTime(), before.rows[0].locked_until.getTime());
});

test("rechecks a lock committed while a correct login waits for the account row", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-lock-race-${Date.now()}@example.com`);
    const blocker = await database.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [account.id]);
    const attempt = login(account.email);
    try {
        // 等到登录查询确实在等待行锁，不依赖固定延迟或随机调度。
        let waiting = false;
        for (let index = 0; index < 200 && !waiting; index++) {
            await blocker.query("SELECT pg_stat_clear_snapshot()");
            const activity = await blocker.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'");
            waiting = activity.rowCount! > 0;
            if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        await blocker.query("UPDATE users SET failed_login_attempts = 5, locked_until = clock_timestamp() + INTERVAL '15 minutes' WHERE id = $1", [account.id]);
        await blocker.query("COMMIT");
        assert.equal((await attempt).response.status, 429);
        const sessions = await database.query("SELECT 1 FROM sessions WHERE user_id = $1", [account.id]);
        assert.equal(sessions.rowCount, 0);
    } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await attempt;
    }
});

test("starts a new failure sequence after a lock expires", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-expired-${Date.now()}@example.com`);
    await database.query("UPDATE users SET failed_login_attempts = 5, locked_until = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [account.id]);
    assert.equal((await login(account.email, "Wrong!Password123")).response.status, 401);
    const row = await database.query("SELECT failed_login_attempts, locked_until FROM users WHERE id = $1", [account.id]);
    assert.equal(row.rows[0].failed_login_attempts, 1);
    assert.equal(row.rows[0].locked_until, null);
    assert.equal((await login(account.email)).response.status, 201);
});

test("allows independent sessions on multiple successful logins", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-devices-${Date.now()}@example.com`);
    const first = await login(account.email);
    const second = await login(account.email);
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.notEqual(first.response.headers.get("set-cookie"), second.response.headers.get("set-cookie"));
});

test("does not lose the lock threshold under concurrent failures", async () => {
    await database.query("DELETE FROM identity_rate_limits");
    const account = await createTestUser(`login-concurrent-${Date.now()}@example.com`);
    const results = await Promise.all(Array.from({ length: 5 }, () => login(account.email, "Wrong!Password123")));
    assert.equal(results.filter((result) => result.response.status === 401).length, 5);
    assert.equal((await login(account.email)).response.status, 429);
});
