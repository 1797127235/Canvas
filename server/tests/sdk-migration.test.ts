import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createTestDatabase } from "./support/database.js";

test("SDK task migration preserves account ownership and task ids, removes legacy column and is repeatable", async () => {
    const database = createTestDatabase(process.env);
    const connection = await database.connect();
    let schemaCreated = false;
    try {
        await connection.query("CREATE SCHEMA sdk_migration_test");
        schemaCreated = true;
        await connection.query("SET search_path TO sdk_migration_test");
        await connection.query("CREATE TABLE users (id UUID PRIMARY KEY)");
        await connection.query(await readFile(new URL("../sql/004-generation-tasks.sql", import.meta.url), "utf8"));
        const userId = randomUUID(), taskId = randomUUID();
        await connection.query("INSERT INTO users (id) VALUES ($1)", [userId]);
        await connection.query("INSERT INTO user_generation_tasks (id, user_id, upstream_id, base_url, model_id) VALUES ($1, $2, $3, $4, $5)", [taskId, userId, "remote-grok-task", "https://gateway.example/v1", "model-alias"]);
        const migration = await readFile(new URL("../sql/006-generation-sdk-operations.sql", import.meta.url), "utf8");
        await connection.query(migration);
        await connection.query(migration);
        const { rows } = await connection.query("SELECT * FROM user_generation_tasks WHERE id = $1", [taskId]);
        assert.equal(rows[0].user_id, userId);
        assert.equal(rows[0].base_url, "https://gateway.example/v1");
        assert.equal(rows[0].upstream_id, undefined);
        assert.deepEqual(rows[0].operation, { version: 1, adapter: "gateway-videos", modelId: "model-alias", operation: { id: "remote-grok-task" } });
        await connection.query("INSERT INTO user_generation_tasks (id, user_id, operation, base_url, model_id) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), userId, JSON.stringify({ version: 1, adapter: "xai-videos", modelId: "grok-imagine-video-1.5", operation: { requestId: "new-task" } }), "https://gateway.example/v1", "grok"]);
        await connection.query(migration);
        assert.equal((await connection.query("SELECT count(*)::int AS count FROM user_generation_tasks")).rows[0].count, 2);
    } finally {
        await connection.query("ROLLBACK");
        await connection.query("SET search_path TO public");
        if (schemaCreated) await connection.query("DROP SCHEMA sdk_migration_test CASCADE");
        connection.release();
        await database.end();
    }
});
