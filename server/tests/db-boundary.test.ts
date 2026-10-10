import assert from "node:assert/strict";
import { test } from "node:test";

import { readTestDatabaseUrl } from "./support/database.js";

test("requires test mode and an explicit PostgreSQL TEST_DATABASE_URL", () => {
    assert.throws(() => readTestDatabaseUrl({ NODE_ENV: "development", TEST_DATABASE_URL: "postgresql://localhost/test" }));
    assert.throws(() => readTestDatabaseUrl({ NODE_ENV: "test", TEST_DATABASE_URL: "not-a-url" }));
    assert.equal(readTestDatabaseUrl({ NODE_ENV: "test", TEST_DATABASE_URL: "postgresql://localhost/infinite_canvas_test" }), "postgresql://localhost/infinite_canvas_test");
});

test("rejects using the application database as the test database", () => {
    assert.throws(() =>
        readTestDatabaseUrl({
            NODE_ENV: "test",
            DATABASE_URL: "postgresql://app:one@localhost:5432/infinite_canvas?sslmode=require",
            TEST_DATABASE_URL: "postgresql://test:two@localhost/infinite_canvas",
        }),
    );
});
