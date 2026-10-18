import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";

import { createSessionStore, AgentThreadError } from "../src/agent/sessions/store.js";
import { createAccount } from "../src/identity/account-repository.js";
import { createTestDatabase } from "./support/database.js";

test("real sessions preserve history, isolate ownership, protect summaries and serialize CAS races", async () => {
    const database = createTestDatabase(process.env);
    const users: string[] = [];
    try {
        for (let i = 0; i < 2; i++) users.push((await createAccount(database, `${randomUUID()}@example.com`, "hash")).id);
        const store = createSessionStore(database);
        const [owner, other] = users;
        const thread = await store.create(owner, "project");
        const second = await store.create(owner, "project");
        assert.equal((await store.list(owner, "project")).length, 2);
        assert.equal(await store.owns(other, "project", thread.threadId), false);
        assert.equal(await store.owns(owner, "other-project", thread.threadId), false);
        await assert.rejects(store.get(other, "project", thread.threadId), (e: unknown) => e instanceof AgentThreadError && e.failure === "not-found");
        const messages: Message[] = [{ id: "u1", role: "user", content: "旧目标" }, { id: "a1", role: "assistant", content: "旧结论" }, { id: "u2", role: "user", content: "新问题" }];
        const saved = await store.save(owner, "project", thread.threadId, 0, messages);
        const version = await store.updateCompactionState(owner, "project", thread.threadId, saved.version, "旧目标与结论", "a1");
        assert.equal(version, 2);
        const compacted = await store.getForCompaction(owner, "project", thread.threadId);
        assert.deepEqual(compacted.messages, messages);
        assert.equal(compacted.compactionSummary, "旧目标与结论");
        assert.equal("compactionSummary" in await store.get(owner, "project", thread.threadId), false);
        await assert.rejects(store.save(owner, "project", thread.threadId, version, messages.slice(1)), /历史不能/);
        await assert.rejects(store.save(owner, "project", thread.threadId, version, [{ id: "u1", role: "user", content: "篡改" }, ...messages.slice(1)]), /历史不能/);
        const appended = [...messages, { id: "a2", role: "assistant", content: "新答案" }] as Message[];
        const after = await store.save(owner, "project", thread.threadId, version, appended);
        assert.equal((await store.getForCompaction(owner, "project", thread.threadId)).compactionSummary, "旧目标与结论");
        const race = await Promise.allSettled([
            store.save(owner, "project", thread.threadId, after.version, [...appended, { id: "u3", role: "user", content: "追加" }]),
            store.updateCompactionState(owner, "project", thread.threadId, after.version, "更新摘要", "a2"),
        ]);
        assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
        assert.equal(race.filter((r) => r.status === "rejected" && r.reason instanceof AgentThreadError && r.reason.failure === "conflict").length, 1);
        assert.equal((await store.get(owner, "project", thread.threadId)).version, after.version + 1);
        await store.delete(owner, "project", second.threadId);
        assert.equal((await store.list(owner, "project")).length, 1);
        await store.pruneOrphans(other, []);
        assert.equal(await store.owns(owner, "project", thread.threadId), true);
        await store.pruneOrphans(owner, []);
        assert.equal((await store.list(owner, "project")).length, 0);
    } finally {
        for (const id of users) await database.query("DELETE FROM users WHERE id = $1", [id]);
        await database.end();
    }
});
