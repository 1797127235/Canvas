import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "../src/config.js";

const environment = {
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: "4100",
    APP_ORIGIN: "http://localhost:3000",
    DATABASE_URL: "postgresql://localhost/infinite_canvas",
    RATE_LIMIT_SECRET: "test-only-secret",
};

test("reads explicit development configuration without connecting to the database", () => {
    const config = readConfig(environment);
    assert.equal(config.port, 4100);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.appOrigin, "http://localhost:3000");
    assert.equal(config.mediaLinkSecret, readConfig(environment).mediaLinkSecret);
    assert.ok(config.mediaLinkSecret);
});

test("requires every startup setting without disclosing its value", () => {
    for (const key of Object.keys(environment)) {
        assert.throws(() => readConfig({ ...environment, [key]: undefined }), /Invalid server configuration/);
    }
});

test("rejects invalid origins and development origins outside localhost", () => {
    for (const origin of ["invalid", "https://example.com/path", "https://example.com/?a=1", "https://user:pass@example.com", "http://example.com", "https://example.com/#fragment"]) {
        assert.throws(() => readConfig({ ...environment, APP_ORIGIN: origin }));
    }
});

test("allows HTTP and HTTPS origins in production", () => {
    assert.equal(readConfig({ ...environment, NODE_ENV: "production" }).appOrigin, "http://localhost:3000");
    assert.equal(readConfig({ ...environment, NODE_ENV: "production", APP_ORIGIN: "http://example.com:3015" }).appOrigin, "http://example.com:3015");
    assert.equal(readConfig({ ...environment, NODE_ENV: "production", APP_ORIGIN: "https://example.com" }).appOrigin, "https://example.com");
    assert.throws(() => readConfig({ ...environment, NODE_ENV: "production", APP_ORIGIN: "ftp://example.com" }));
});

test("rejects invalid ports and non-PostgreSQL database URLs", () => {
    for (const port of ["", "0", "-1", "65536", "4.5", "4100junk"]) {
        assert.throws(() => readConfig({ ...environment, PORT: port }));
    }
    assert.throws(() => readConfig({ ...environment, DATABASE_URL: "https://example.com" }));
});

test("requires explicit valid compaction budgets and never guesses a model window", () => {
    assert.deepEqual(readConfig(environment).agentCompactionBudgets, {});
    const budget = { contextWindow: 32000, maxOutputTokens: 2000, keepRecentTokens: 6000, summaryTokens: 1200, safetyTokens: 1000 };
    assert.deepEqual(readConfig({ ...environment, AGENT_COMPACTION_BUDGETS: JSON.stringify({ exact: budget }) }).agentCompactionBudgets.exact, budget);
    assert.throws(() => readConfig({ ...environment, AGENT_COMPACTION_BUDGETS: "invalid" }), /预算配置无效/);
});

test("never exposes database credentials in configuration errors", () => {
    assert.throws(
        () => readConfig({ ...environment, DATABASE_URL: "not-a-url-containing-private-password" }),
        (error: unknown) => error instanceof Error && error.message === "Invalid server configuration: DATABASE_URL",
    );
});
