import { expect, test } from "bun:test";
import { HttpAgent, type AbstractAgent, type Message } from "@ag-ui/client";
import { createSessionSaveQueue } from "../src/lib/agent/session-save-queue";
import { bindSessionPersistence } from "../src/lib/agent/session-run";

test("every run persists first, refreshes summary version, then saves generated messages", async () => {
    let version = 0;
    let stored: Message[] = [];
    let requests = 0;
    const queue = createSessionSaveQueue(async (_id, expected, messages) => {
        expect(expected).toBe(version);
        stored = structuredClone(messages);
        return { version: ++version, title: "title" };
    }, () => undefined, async () => ({ version: 0, messages: [] }));
    queue.markSaved("thread", 0, []);
    const agent = { threadId: "thread", messages: [{ id: "u", role: "user", content: "hi" }] as Message[], runAgent: async (params: { forwardedProps: Record<string, unknown> }) => {
        requests++;
        expect(params.forwardedProps.projectId).toBe("project");
        expect(params.forwardedProps.sessionVersion).toBe(version);
        version++; // server compaction CAS
        agent.messages.push({ id: `a${requests}`, role: "assistant", content: "done" });
        return {};
    } };
    bindSessionPersistence(agent as unknown as AbstractAgent, { queue, load: async () => ({ version, messages: structuredClone(stored) }), onBusy: () => undefined, isActive: () => true });
    await agent.runAgent({ forwardedProps: { projectId: "project" } });
    expect(stored).toEqual(agent.messages);
    await agent.runAgent({ forwardedProps: { projectId: "project" } });
    expect(requests).toBe(2);
    expect(stored).toEqual(agent.messages);
});

test("failed pre-save blocks HTTP and retains local history", async () => {
    let called = false;
    const queue = createSessionSaveQueue(async () => { throw new Error("offline"); }, () => undefined, async () => ({ version: 0, messages: [] }));
    queue.markSaved("t", 0, []);
    const agent = { threadId: "t", messages: [{ id: "u", role: "user", content: "hi" }] as Message[], runAgent: async () => { called = true; } };
    bindSessionPersistence(agent as unknown as AbstractAgent, { queue, load: async () => ({ version: 0, messages: [] }), onBusy: () => undefined, isActive: () => true });
    await expect(agent.runAgent()).rejects.toThrow("offline");
    expect(called).toBe(false);
    expect(agent.messages).toHaveLength(1);
});

test("installed HttpAgent runs through persistence without losing forwarded properties", async () => {
    let version = 0;
    let stored: Message[] = [];
    const queue = createSessionSaveQueue(async (_id, expected, messages) => {
        expect(expected).toBe(version); stored = structuredClone(messages); return { version: ++version, title: "t" };
    }, () => undefined, async () => ({ version: 0, messages: [] }));
    queue.markSaved("t", 0, []);
    const agent = new HttpAgent({ threadId: "t", url: "http://test.invalid/run", initialMessages: [{ id: "u", role: "user", content: "hi" }], fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.forwardedProps.sessionVersion).toBe(version);
        expect(body.forwardedProps.projectId).toBe("p");
        version++;
        const events = [{ type: "RUN_STARTED", threadId: "t", runId: body.runId }, { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" }, { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "hello" }, { type: "TEXT_MESSAGE_END", messageId: "a" }, { type: "RUN_FINISHED", threadId: "t", runId: body.runId }];
        return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    } });
    bindSessionPersistence(agent, { queue, load: async () => ({ version, messages: stored }), onBusy: () => undefined, isActive: () => true });
    await agent.runAgent({ forwardedProps: { projectId: "p" } });
    expect(stored.at(-1)?.content).toBe("hello");
    expect(queue.isDirty("t", agent.messages)).toBe(false);
});

test("run failure after server compaction still reconciles version and retains partial reply", async () => {
    let version = 0;
    let stored: Message[] = [];
    const queue = createSessionSaveQueue(async (_id, expected, messages) => { expect(expected).toBe(version); stored = structuredClone(messages); return { version: ++version, title: "t" }; }, () => undefined, async () => ({ version: 0, messages: [] }));
    queue.markSaved("t", 0, []);
    const agent = { threadId: "t", messages: [{ id: "u", role: "user", content: "hi" }] as Message[], runAgent: async () => { version++; agent.messages.push({ id: "a", role: "assistant", content: "partial" }); throw new Error("disconnected"); } };
    bindSessionPersistence(agent as unknown as AbstractAgent, { queue, load: async () => ({ version, messages: stored }), onBusy: () => undefined, isActive: () => true });
    await expect(agent.runAgent()).rejects.toThrow("disconnected");
    expect(stored.at(-1)?.content).toBe("partial");
    expect(queue.version("t")).toBe(version);
});

test("a concurrent remote edit cannot be accepted as a new baseline", async () => {
    const messages = [{ id: "u", role: "user", content: "local" }] as Message[];
    const queue = createSessionSaveQueue(async (_id, version) => ({ version: version + 1, title: "t" }), () => undefined, async () => ({ version: 0, messages: [] }));
    queue.markSaved("t", 0, messages);
    const agent = { threadId: "t", messages, runAgent: async () => ({}) };
    bindSessionPersistence(agent as unknown as AbstractAgent, { queue, load: async () => ({ version: 2, messages: [{ id: "u", role: "user", content: "remote" }] }), onBusy: () => undefined, isActive: () => true });
    await expect(agent.runAgent()).rejects.toThrow("冲突");
    expect(agent.messages[0].content).toBe("local");
});
