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

test("requires HTTPS in production", () => {
    assert.throws(() => readConfig({ ...environment, NODE_ENV: "production" }));
    assert.equal(readConfig({ ...environment, NODE_ENV: "production", APP_ORIGIN: "https://example.com" }).appOrigin, "https://example.com");
});

test("rejects invalid ports and non-PostgreSQL database URLs", () => {
    for (const port of ["", "0", "-1", "65536", "4.5", "4100junk"]) {
        assert.throws(() => readConfig({ ...environment, PORT: port }));
    }
    assert.throws(() => readConfig({ ...environment, DATABASE_URL: "https://example.com" }));
});

test("never exposes database credentials in configuration errors", () => {
    assert.throws(
        () => readConfig({ ...environment, DATABASE_URL: "not-a-url-containing-private-password" }),
        (error: unknown) => error instanceof Error && error.message === "Invalid server configuration: DATABASE_URL",
    );
});
