import assert from "node:assert/strict";
import { test } from "node:test";
import type { BaseEvent, EventType } from "@ag-ui/core";
import type { TextStreamPart, ToolSet } from "ai";

import { createEventMapper, runStarted, sseFrame } from "../src/agent/events.js";

const context = { threadId: "thread-1", runId: "run-1" };

// 事件映射是整套接入里最容易出错的一层，用假的 part 序列把形状锁死，不依赖网络和模型。
function collect(parts: TextStreamPart<ToolSet>[], ids: string[] = []) {
    let index = 0;
    const mapper = createEventMapper(context, () => ids[index++] ?? `generated-${index}`);
    const events: BaseEvent[] = [runStarted(context)];
    for (const part of parts) {
        const { events: emitted, terminal } = mapper.map(part);
        events.push(...emitted);
        if (terminal) {
            events.push(terminal);
            return events;
        }
    }
    events.push(...mapper.finish());
    return events;
}

const types = (events: BaseEvent[]) => events.map((event) => (event as { type: EventType }).type);

test("maps plain text to start/content/end around the assistant message", () => {
    const events = collect([
        { type: "text-start", id: "text-1" } as TextStreamPart<ToolSet>,
        { type: "text-delta", id: "text-1", text: "你好" } as TextStreamPart<ToolSet>,
        { type: "text-delta", id: "text-1", text: "，画布" } as TextStreamPart<ToolSet>,
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } as unknown as TextStreamPart<ToolSet>,
    ]);

    assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
    const text = events.filter((event) => (event as { type: EventType }).type === "TEXT_MESSAGE_CONTENT").map((event) => (event as unknown as { delta: string }).delta);
    assert.deepEqual(text, ["你好", "，画布"]);
    const started = events.find((event) => (event as { type: EventType }).type === "TEXT_MESSAGE_START") as unknown as { messageId: string };
    // 上游 part.id 可能是重复的内容块序号，消息 id 必须由我们自己签发。
    assert.notEqual(started.messageId, "text-1");
    const finished = events.at(-1) as unknown as { usage: Array<Record<string, number>> };
    assert.equal(finished.usage[0].totalTokens, 14);
});

test("gives each assistant text span its own message id when the provider reuses part ids", () => {
    const events = collect([
        { type: "text-delta", id: "0", text: "第一段" } as TextStreamPart<ToolSet>,
        { type: "text-end", id: "0" } as TextStreamPart<ToolSet>,
        { type: "tool-call", toolCallId: "call-1", toolName: "apply_graph", input: { nodes: [] } } as unknown as TextStreamPart<ToolSet>,
        { type: "text-start", id: "0" } as TextStreamPart<ToolSet>,
        { type: "text-delta", id: "0", text: "第二段" } as TextStreamPart<ToolSet>,
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} } as unknown as TextStreamPart<ToolSet>,
    ]);

    const starts = events.filter((event) => (event as { type: EventType }).type === "TEXT_MESSAGE_START") as unknown as Array<{ messageId: string }>;
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].messageId, starts[1].messageId);
    assert.notEqual(starts[0].messageId, "0");
    const contents = events.filter((event) => (event as { type: EventType }).type === "TEXT_MESSAGE_CONTENT") as unknown as Array<{ messageId: string; delta: string }>;
    assert.deepEqual(contents.map((event) => [event.messageId, event.delta]), [[starts[0].messageId, "第一段"], [starts[1].messageId, "第二段"]]);
});

test("streams a tool call as start/args/end and closes the text message first", () => {
    const events = collect([
        { type: "text-delta", id: "text-1", text: "我来建节点" } as TextStreamPart<ToolSet>,
        { type: "tool-input-start", id: "call-1", toolName: "apply_graph" } as TextStreamPart<ToolSet>,
        { type: "tool-input-delta", id: "call-1", delta: '{"nodes":' } as TextStreamPart<ToolSet>,
        { type: "tool-input-delta", id: "call-1", delta: "[]}" } as TextStreamPart<ToolSet>,
        { type: "tool-input-end", id: "call-1" } as TextStreamPart<ToolSet>,
        { type: "tool-call", toolCallId: "call-1", toolName: "apply_graph", input: { nodes: [] } } as unknown as TextStreamPart<ToolSet>,
        { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls", totalUsage: {} } as unknown as TextStreamPart<ToolSet>,
    ]);

    assert.deepEqual(types(events), ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_ARGS", "TOOL_CALL_END", "RUN_FINISHED"]);
    const start = events.find((event) => (event as { type: EventType }).type === "TOOL_CALL_START") as unknown as { toolCallId: string; toolCallName: string; parentMessageId: string };
    assert.equal(start.toolCallId, "call-1");
    assert.equal(start.toolCallName, "apply_graph");
    // 工具调用挂在这条助手消息下面，客户端据此把气泡排在正确的消息里。
    assert.equal(start.parentMessageId, (events[1] as unknown as { messageId: string }).messageId);
});

test("serializes tool arguments once when the provider sends no argument deltas", () => {
    const events = collect([
        { type: "tool-call", toolCallId: "call-2", toolName: "apply_graph", input: { nodes: [{ key: "a" }] } } as unknown as TextStreamPart<ToolSet>,
        { type: "finish", finishReason: "tool-calls", rawFinishReason: "tool_calls", totalUsage: {} } as unknown as TextStreamPart<ToolSet>,
    ]);

    const args = events.filter((event) => (event as { type: EventType }).type === "TOOL_CALL_ARGS");
    assert.equal(args.length, 1);
    assert.deepEqual(JSON.parse((args[0] as unknown as { delta: string }).delta), { nodes: [{ key: "a" }] });
});

test("turns a stream error into RUN_ERROR and reports tool failures as tool results", () => {
    const failed = collect([{ type: "error", error: new Error("上游超时") } as TextStreamPart<ToolSet>]);
    assert.deepEqual(types(failed), ["RUN_STARTED", "RUN_ERROR"]);
    assert.equal((failed.at(-1) as unknown as { message: string }).message, "上游超时");

    const toolError = collect([
        { type: "tool-error", toolCallId: "call-3", toolName: "apply_graph", input: {}, error: new Error("参数不合法") } as unknown as TextStreamPart<ToolSet>,
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} } as unknown as TextStreamPart<ToolSet>,
    ]);
    const result = toolError.find((event) => (event as { type: EventType }).type === "TOOL_CALL_RESULT") as unknown as { content: string };
    assert.equal(result.content, "Error: 参数不合法");
});

test("frames events as server-sent event data lines", () => {
    assert.equal(sseFrame(runStarted(context) as never), `data: ${JSON.stringify(runStarted(context))}\n\n`);
});
