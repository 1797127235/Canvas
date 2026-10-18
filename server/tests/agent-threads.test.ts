import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";

import { AgentThreadError, createSessionStore, titleFromMessages, validateMessages } from "../src/agent/sessions/store.js";

test("uses the first user message as a compact conversation title", () => {
    const messages = [
        { id: "a", role: "assistant", content: "欢迎" },
        { id: "u", role: "user", content: "  帮我设计一个\n海边咖啡馆  " },
        { id: "u2", role: "user", content: "后续内容" },
    ] as Message[];
    assert.equal(titleFromMessages(messages), "帮我设计一个 海边咖啡馆");
});

test("falls back to a new conversation title when no user text exists", () => {
    assert.equal(titleFromMessages([]), "新对话");
    assert.equal(titleFromMessages([{ id: "u", role: "user", content: [{ type: "image", source: { type: "url", value: "https://example.invalid/image.png" } }] } as Message]), "新对话");
});

test("validates thread message collections without trimming history", () => {
    const messages = [{ id: "u", role: "user", content: "hello" }] as Message[];
    assert.equal(validateMessages(messages), messages);
    assert.throws(() => validateMessages("invalid"), /格式无效/);
});

test("updates compaction state only at a valid message boundary and version", async () => {
    const messages = [{ id: "u", role: "user", content: "hello" }] as Message[];
    const calls: string[] = [];
    const database = {
        query: async <T>(sql: string) => {
            calls.push(sql);
            if (sql.includes("SELECT thread_id, title, version, messages, updated_at, compaction_summary")) {
                return { rows: [{ thread_id: "thread", title: "新对话", version: "3", messages, updated_at: "2026-01-01T00:00:00Z", compaction_summary: null, covered_through_message_id: null }] as T[] };
            }
            if (sql.includes("UPDATE user_agent_threads SET compaction_summary")) return { rows: [{ version: "4" }] as T[] };
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
    const store = createSessionStore(database as never);
    assert.equal(await store.updateCompactionState("user", "project", "thread", 3, "summary", "u"), 4);
    await assert.rejects(() => store.updateCompactionState("user", "project", "thread", 3, "summary", "missing"), AgentThreadError);
    assert.equal(calls.filter((sql) => sql.includes("UPDATE user_agent_threads SET compaction_summary")).length, 1);
});

test("does not expose compaction metadata in public session reads", async () => {
    const database = {
        query: async <T>() => ({ rows: [{ thread_id: "thread", title: "新对话", version: "4", messages: [], updated_at: "2026-01-01T00:00:00Z", compaction_summary: "private summary", covered_through_message_id: "user-1" }] as T[] }),
    };
    const store = createSessionStore(database as never);
    const session = await store.get("user", "project", "thread");
    assert.equal("compactionSummary" in session, false);
    assert.equal("coveredThroughMessageId" in session, false);
});

test("rejects compaction updates when the session version is stale", async () => {
    const database = {
        query: async <T>(sql: string) => {
            if (sql.includes("SELECT thread_id, title, version, messages, updated_at, compaction_summary")) {
                return { rows: [{ thread_id: "thread", title: "新对话", version: "4", messages: [], updated_at: "2026-01-01T00:00:00Z", compaction_summary: "old", covered_through_message_id: null }] as T[] };
            }
            throw new Error(`Unexpected query: ${sql}`);
        },
    };
    const store = createSessionStore(database as never);
    await assert.rejects(() => store.updateCompactionState("user", "project", "thread", 3, "summary", "missing"), (error: unknown) => error instanceof AgentThreadError && error.failure === "conflict");
});
