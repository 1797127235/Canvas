import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { clearExpiredRateLimits, createRateLimiter, consumeRateLimit, normalizeRemoteAddress, rateLimitKey } from "../src/identity/rate-limit.js";
import { createTestDatabase } from "./support/database.js";

const database = createTestDatabase(process.env);
const secret = "rate-limit-test-secret";

before(async () => {
    await database.query("DELETE FROM identity_rate_limits");
});

after(async () => {
    await database.query("DELETE FROM identity_rate_limits");
    await database.end();
});

test("normalizes mapped IPv4 addresses and never puts the raw address in the key", () => {
    assert.equal(normalizeRemoteAddress(" ::ffff:127.0.0.1 "), "127.0.0.1");
    const key = rateLimitKey(secret, "login", "::ffff:127.0.0.1");
    assert.match(key, /^login:[a-f0-9]{64}$/);
    assert.doesNotMatch(key, /127\.0\.0\.1/);
});

test("enforces the approved login and registration fixed windows", async () => {
    const login = createRateLimiter(database, "login", secret);
    const register = createRateLimiter(database, "register", secret);

    for (let index = 0; index < 30; index += 1) await consumeRateLimit(login, secret, "login", "192.0.2.10");
    await assert.rejects(() => consumeRateLimit(login, secret, "login", "192.0.2.10"));

    for (let index = 0; index < 10; index += 1) await consumeRateLimit(register, secret, "register", "192.0.2.10");
    await assert.rejects(() => consumeRateLimit(register, secret, "register", "192.0.2.10"));
});

test("clears only expired fixed-window rows explicitly", async () => {
    await database.query("INSERT INTO identity_rate_limits (key, points, expire) VALUES ($1, $2, $3)", ["expired-test-row", 1, Date.now() - 1]);
    await clearExpiredRateLimits(database);
    const result = await database.query("SELECT key FROM identity_rate_limits WHERE key = $1", ["expired-test-row"]);
    assert.equal(result.rowCount, 0);
});

test("shares counters between limiter instances using the same PostgreSQL table", async () => {
    const first = createRateLimiter(database, "login", secret);
    const second = createRateLimiter(database, "login", secret);
    await consumeRateLimit(first, secret, "login", "192.0.2.11", 29);
    await assert.rejects(() => consumeRateLimit(second, secret, "login", "192.0.2.11", 2));
});
