import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import type { Message } from "@ag-ui/core";

import { createApp } from "../src/app.js";
import { createAgentRouter } from "../src/agent/routes.js";
import { createSessionStore } from "../src/agent/sessions/store.js";
import { createAccount } from "../src/identity/account-repository.js";
import { createSession, serializeSessionCookie } from "../src/identity/session.js";
import { encryptCredential } from "../src/credential-crypto.js";
import { createTestDatabase } from "./support/database.js";
import { startTestServer } from "./support/http.js";

test("HTTP compaction retains full history, sends summary plus recent messages, and accepts the new version", async () => {
    const database = createTestDatabase(process.env);
    const upstream = express();
    upstream.use(express.json());
    const requests: Array<{ stream?: boolean; model: string; messages: Array<{ role: string; content: unknown }> }> = [];
    let summaryReason = "stop";
    upstream.get("/v1/models", (_req, res) => res.json({ data: [{ id: "test-model", capability: "text" }, { id: "alternate-model", capability: "text" }] }));
    upstream.post("/v1/chat/completions", (req, res) => {
        requests.push(req.body);
        if (!req.body.stream) return res.json({ id: "summary", object: "chat.completion", created: 1, model: "test-model", choices: [{ index: 0, message: { role: "assistant", content: "用户需要海边咖啡馆画布，旧目标已讨论。" }, finish_reason: summaryReason }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
        res.type("text/event-stream");
        for (const chunk of [
            { id: "answer", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { role: "assistant", content: "继续搭建" }, finish_reason: null }] },
            { id: "answer", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
        ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
    });
    const remote = await startTestServer(upstream);
    const encryptionKey = randomBytes(32).toString("base64");
    const user = await createAccount(database, `${randomUUID()}@example.com`, "hash");
    const session = await createSession(database, user.id);
    const origin = "http://localhost:3000";
    const headers = { origin, cookie: serializeSessionCookie(session.sid, false), "Content-Type": "application/json" };
    await database.query("INSERT INTO user_credentials (user_id, encrypted_api_key, base_url) VALUES ($1, $2, $3)", [user.id, encryptCredential("fake-test-key", encryptionKey), `${remote.baseUrl}/v1`]);
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createAgentRouter({ database, catalog: { models: [] }, encryptionKey, compactionBudgets: { "test-model": { contextWindow: 8000, maxOutputTokens: 500, keepRecentTokens: 900, summaryTokens: 300, safetyTokens: 200 } } }) }));
    try {
        const created = await fetch(`${api.baseUrl}/api/agent/threads/project`, { method: "POST", headers, body: "{}" });
        assert.equal(created.status, 201);
        const thread = await created.json() as { threadId: string; version: number };
        const store = createSessionStore(database);
        const messages: Message[] = [{ id: "u1", role: "user", content: "旧目标".repeat(240) }, { id: "a1", role: "assistant", content: "旧回答".repeat(240) }, { id: "u2", role: "user", content: "继续" }];
        const saved = await store.save(user.id, "project", thread.threadId, thread.version, messages);
        const run = async (version: number) => {
            const res = await fetch(`${api.baseUrl}/api/copilotkit/agent/default/run`, { method: "POST", headers, body: JSON.stringify({ threadId: thread.threadId, runId: randomUUID(), state: {}, messages, tools: [], context: [{ description: "当前画布", value: "画布状态".repeat(120) }], forwardedProps: { projectId: "project", sessionVersion: version, modelId: "test-model" } }) });
            assert.equal(res.status, 200);
            return res.text();
        };
        const stream = await run(saved.version);
        assert.match(stream, /session_version/);
        assert.match(stream, /继续搭建/);
        assert.match(stream, /RUN_FINISHED/);
        const compacted = await store.getForCompaction(user.id, "project", thread.threadId);
        assert.deepEqual(compacted.messages, messages);
        assert.equal(compacted.coveredThroughMessageId, "a1");
        assert.equal(compacted.version, saved.version + 1);
        const generation = requests.find((r) => r.stream)!;
        assert.ok(generation);
        assert.ok(requests.every((request) => request.model === "test-model"));
        assert.equal(generation.messages.filter((m) => m.role === "user").length, 2);
        assert.doesNotMatch(JSON.stringify(generation.messages.filter((m) => m.role === "system")), /海边咖啡馆/);
        assert.match(JSON.stringify(generation), /海边咖啡馆/);
        assert.doesNotMatch(JSON.stringify(generation), /旧目标旧目标/);
        const follow = await store.save(user.id, "project", thread.threadId, compacted.version, [...messages, { id: "a2", role: "assistant", content: "完成" }]);
        assert.equal(follow.version, compacted.version + 1);
        const invalid = await fetch(`${api.baseUrl}/api/agent/threads/project/${thread.threadId}`, { method: "PUT", headers: { ...headers, "If-Match-Version": String(follow.version) }, body: JSON.stringify({ messages, compactionSummary: "伪造摘要", coveredThroughMessageId: "u2" }) });
        assert.equal(invalid.status, 422);

        const failedThread = await store.create(user.id, "failed");
        const failedSaved = await store.save(user.id, "failed", failedThread.threadId, 0, messages);
        const alternate = await fetch(`${api.baseUrl}/api/copilotkit/agent/default/run`, { method: "POST", headers, body: JSON.stringify({ threadId: failedThread.threadId, runId: randomUUID(), state: {}, messages, tools: [], context: [{ description: "画布", value: "画布状态".repeat(120) }], forwardedProps: { projectId: "failed", sessionVersion: failedSaved.version, modelId: "alternate-model" } }) });
        assert.equal(alternate.status, 200);
        await alternate.text();
        assert.equal(requests.at(-1)?.model, "alternate-model");
        const unavailable = await fetch(`${api.baseUrl}/api/copilotkit/agent/default/run`, { method: "POST", headers, body: JSON.stringify({ threadId: failedThread.threadId, runId: randomUUID(), state: {}, messages, tools: [], context: [], forwardedProps: { projectId: "failed", sessionVersion: failedSaved.version, modelId: "removed-model" } }) });
        assert.equal(unavailable.status, 424);
        summaryReason = "length";
        const failed = await fetch(`${api.baseUrl}/api/copilotkit/agent/default/run`, { method: "POST", headers, body: JSON.stringify({ threadId: failedThread.threadId, runId: randomUUID(), state: {}, messages, tools: [], context: [{ description: "画布", value: "画布状态".repeat(120) }], forwardedProps: { projectId: "failed", sessionVersion: failedSaved.version, modelId: "test-model" } }) });
        assert.match(await failed.text(), /RUN_ERROR/);
        const unchanged = await store.getForCompaction(user.id, "failed", failedThread.threadId);
        assert.equal(unchanged.version, failedSaved.version);
        assert.equal(unchanged.compactionSummary, null);
    } finally {
        await api.close();
        await remote.close();
        await database.query("DELETE FROM users WHERE id = $1", [user.id]);
        await database.end();
    }
});
