import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunAgentInput } from "@ag-ui/core";
import type { CatalogModel } from "../src/catalog/catalog.js";
import type { AgentSession, SessionStore } from "../src/agent/sessions/store.js";
import { prepareAgentContext } from "../src/agent/compaction/prepare.js";

const budget = { contextWindow: 6000, maxOutputTokens: 500, keepRecentTokens: 900, summaryTokens: 300, safetyTokens: 200 };
function fixture() {
    const session: AgentSession = { threadId: "t", title: "title", version: 1, updatedAt: new Date(0).toISOString(), compactionSummary: null, coveredThroughMessageId: null, messages: [{ id: "u1", role: "user", content: "旧".repeat(800) }, { id: "a1", role: "assistant", content: "答".repeat(800) }, { id: "u2", role: "user", content: "新问题" }] };
    let commits = 0;
    const sessions = { getForCompaction: async () => structuredClone(session), updateCompactionState: async (_u: string, _p: string, _t: string, version: number, summary: string, boundary: string) => {
        assert.equal(version, session.version);
        commits++; session.version++; session.compactionSummary = summary; session.coveredThroughMessageId = boundary; return session.version;
    } } as unknown as SessionStore;
    const input = { threadId: "t", runId: "r", state: {}, messages: structuredClone(session.messages), tools: [], context: [], forwardedProps: { sessionVersion: 1 } } as RunAgentInput;
    return { session, sessions, input, commits: () => commits };
}
const base = { userId: "u", projectId: "p", model: {} as CatalogModel, apiKey: "fake", signal: new AbortController().signal, budget, instructions: "system".repeat(150) };

test("commits summary plus boundary once and leaves complete messages intact", async () => {
    const f = fixture(); const before = structuredClone(f.session.messages);
    const result = await prepareAgentContext({ ...base, ...f, summarize: async () => "摘要" });
    assert.equal(f.commits(), 1);
    assert.equal(result.version, 2);
    assert.equal(result.messages.length, 2);
    assert.match(String(result.messages[0].content), /摘要/);
    assert.doesNotMatch(result.instructions, /旧对话摘要/);
    assert.deepEqual(f.session.messages, before);
});

test("failed or cancelled summaries never commit", async () => {
    for (const cancelled of [false, true]) {
        const f = fixture(); const controller = new AbortController();
        await assert.rejects(prepareAgentContext({ ...base, ...f, signal: controller.signal, summarize: async () => { if (cancelled) { controller.abort(); return "摘要"; } throw new Error("failed"); } }));
        assert.equal(f.commits(), 0);
        assert.equal(f.session.coveredThroughMessageId, null);
    }
});

test("a stale version or unpersisted input is rejected before any summary call", async () => {
    for (const badVersion of [false, true]) {
        const f = fixture();
        if (badVersion) f.input.forwardedProps.sessionVersion = 0;
        else f.input.messages.push({ id: "extra", role: "user", content: "not saved" });
        await assert.rejects(prepareAgentContext({ ...base, ...f, summarize: async () => { throw new Error("must not call"); } }), /版本或消息/);
        assert.equal(f.commits(), 0);
    }
});

test("without an explicit model budget, persisted summary is applied without generation", async () => {
    const f = fixture(); f.session.compactionSummary = "既有摘要"; f.session.coveredThroughMessageId = "a1";
    const result = await prepareAgentContext({ ...base, ...f, budget: undefined, summarize: async () => { throw new Error("must not call"); } });
    assert.equal(result.messages.length, 2); assert.match(String(result.messages[0].content), /既有摘要/); assert.equal(f.commits(), 0);
});
