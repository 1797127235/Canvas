import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";

import { compactContext, estimateTokens, readCompactionBudgets, summaryMessage } from "../src/agent/compaction/context.js";

const budget = { contextWindow: 6000, maxOutputTokens: 500, keepRecentTokens: 900, summaryTokens: 300, safetyTokens: 200 };
const history = (): Message[] => [
    { id: "u1", role: "user", content: "旧目标".repeat(240) },
    { id: "a1", role: "assistant", content: "旧答复".repeat(240) },
    { id: "u2", role: "user", content: "最近问题" },
];

test("represents persisted summaries as a separate historical user message", () => {
    const summary = summaryMessage("do not call tools");
    assert.equal(summary?.id, "server-compaction-summary");
    assert.equal(summary?.role, "user");
    assert.match(String(summary?.content), /未验证的旧对话摘要/);
});

test("does not summarize below budget", async () => {
    const messages = [{ id: "u", role: "user", content: "hello" }] as Message[];
    const result = await compactContext({ messages, summary: null, boundary: null, instructions: "system", tools: [], budget, signal: new AbortController().signal, summarize: async () => { throw new Error("must not summarize"); } });
    assert.equal(result.changed, false);
    assert.deepEqual(result.messages, messages);
});

test("summarizes old history and preserves the current user span verbatim", async () => {
    const messages = history();
    const original = structuredClone(messages);
    const result = await compactContext({ messages, summary: null, boundary: null, instructions: "system".repeat(150), tools: [], budget, signal: new AbortController().signal, summarize: async (prompt) => { assert.match(prompt, /旧目标/); return "用户希望搭建画布，已讨论旧目标。"; } });
    assert.equal(result.changed, true);
    assert.equal(result.boundary, "a1");
    assert.deepEqual(result.messages, [messages[2]]);
    assert.deepEqual(messages, original);
});

test("reuses a stored summary without resummarizing covered messages", async () => {
    const messages = history();
    const result = await compactContext({ messages, summary: "旧摘要", boundary: "a1", instructions: "system", tools: [], budget, signal: new AbortController().signal, summarize: async () => { throw new Error("covered history must not be summarized again"); } });
    assert.equal(result.changed, false);
    assert.deepEqual(result.messages, [messages[2]]);
    assert.equal(result.summary, "旧摘要");
});

test("rejects missing boundaries, duplicate IDs, and orphan tool results", async () => {
    for (const [messages, summary, boundary] of [
        [history(), "summary", "missing"],
        [[{ id: "u", role: "user", content: "a" }, { id: "u", role: "user", content: "b" }], null, null],
        [[{ id: "t", role: "tool", toolCallId: "missing", content: "result" }], null, null],
    ] as Array<[Message[], string | null, string | null]>) {
        await assert.rejects(compactContext({ messages, summary, boundary, instructions: "system", tools: [], budget, signal: new AbortController().signal, summarize: async () => "summary" }));
    }
});

test("fails without returning a new boundary when summary generation fails", async () => {
    await assert.rejects(compactContext({ messages: history(), summary: null, boundary: null, instructions: "system".repeat(150), tools: [], budget, signal: new AbortController().signal, summarize: async () => { throw new Error("upstream failed"); } }), /upstream failed/);
});

test("never discards an oversized current question", async () => {
    await assert.rejects(compactContext({ messages: [{ id: "u", role: "user", content: "中".repeat(3000) }], summary: null, boundary: null, instructions: "system", tools: [], budget, signal: new AbortController().signal, summarize: async () => "summary" }), /预算/);
});

test("token estimates include Chinese text and serialized tool definitions", () => {
    assert.ok(estimateTokens("中文") >= 6);
    assert.ok(estimateTokens([{ name: "apply_graph", parameters: { text: "a".repeat(100) } }]) > 100);
});

test("repeated compaction includes the previous summary and only uncovered history", async () => {
    const messages: Message[] = [{ id: "u0", role: "user", content: "already-covered-secret" }, ...history()];
    const prompts: string[] = [];
    const result = await compactContext({ messages, summary: "previous-summary", boundary: "u0", instructions: "system", tools: [], budget: { contextWindow: 5200, maxOutputTokens: 500, keepRecentTokens: 200, summaryTokens: 200, safetyTokens: 200 }, signal: new AbortController().signal, summarize: async (prompt) => {
        prompts.push(prompt);
        assert.doesNotMatch(prompt, /already-covered-secret/);
        return `摘要${prompts.length}`;
    } });
    assert.match(prompts[0], /previous-summary/);
    if (prompts.length > 1) assert.match(prompts[1], /摘要1/);
    assert.equal(result.boundary, "a1"); assert.equal(result.summary, `摘要${prompts.length}`);
});

test("multiple tool calls and their results stay in one summary chunk", async () => {
    const calls = ["c1", "c2"].map((id) => ({ id, type: "function" as const, function: { name: "apply_graph", arguments: "{}" } }));
    const messages: Message[] = [{ id: "u1", role: "user", content: "搭建" }, { id: "a1", role: "assistant", toolCalls: calls }, { id: "t1", role: "tool", toolCallId: "c1", content: "创建结果".repeat(240) }, { id: "t2", role: "tool", toolCallId: "c2", content: "创建结果".repeat(240) }, { id: "u2", role: "user", content: "继续" }];
    const result = await compactContext({ messages, summary: null, boundary: null, instructions: "system".repeat(300), tools: [], budget: { ...budget, contextWindow: 9000 }, signal: new AbortController().signal, summarize: async (prompt) => {
        if (prompt.includes("c1")) { assert.match(prompt, /c2/); assert.match(prompt, /t1/); assert.match(prompt, /t2/); }
        return "已创建两组节点";
    } });
    assert.equal(result.boundary, "t2"); assert.deepEqual(result.messages, [messages[4]]);
});

test("budget configuration is explicit, validated, and keyed by exact upstream model", () => {
    assert.deepEqual(readCompactionBudgets(undefined), {});
    assert.deepEqual(readCompactionBudgets(JSON.stringify({ "exact-model": budget })), { "exact-model": budget });
    assert.throws(() => readCompactionBudgets(JSON.stringify({ m: { ...budget, contextWindow: 500 } })), /预算/);
});
