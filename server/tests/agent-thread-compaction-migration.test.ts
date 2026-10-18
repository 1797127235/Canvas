import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createTestDatabase } from "./support/database.js";

test("agent thread compaction migration preserves messages and is repeatable", async () => {
    const database = createTestDatabase(process.env);
    const connection = await database.connect();
    try {
        await connection.query("BEGIN");
        await connection.query("CREATE SCHEMA agent_thread_compaction_test");
        await connection.query("SET search_path TO agent_thread_compaction_test");
        await connection.query("CREATE TABLE users (id UUID PRIMARY KEY)");
        await connection.query(await readFile(new URL("../sql/011-agent-threads.sql", import.meta.url), "utf8"));
        const userId = randomUUID();
        await connection.query("INSERT INTO users (id) VALUES ($1)", [userId]);
        const messages = [{ id: "user-1", role: "user", content: "hello" }];
        await connection.query("INSERT INTO user_agent_threads (user_id, project_id, thread_id, messages) VALUES ($1, $2, $3, $4)", [userId, "project", randomUUID(), JSON.stringify(messages)]);
        for (const file of ["012-agent-multiple-threads.sql", "013-agent-thread-compaction.sql"]) {
            const migration = await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8");
            await connection.query(migration);
            await connection.query(migration);
        }
        const { rows } = await connection.query("SELECT messages, compaction_summary, covered_through_message_id FROM user_agent_threads");
        await connection.query("SAVEPOINT invalid_pair");
        await assert.rejects(connection.query("UPDATE user_agent_threads SET compaction_summary = $1", ["unpaired"]), { code: "23514" });
        await connection.query("ROLLBACK TO SAVEPOINT invalid_pair");
        assert.deepEqual(rows[0].messages, messages);
        assert.equal(rows[0].compaction_summary, null);
        assert.equal(rows[0].covered_through_message_id, null);
    } finally {
        await connection.query("ROLLBACK");
        connection.release();
        await database.end();
    }
});
