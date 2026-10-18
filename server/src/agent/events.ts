import { EventType, PROTOCOL_VERSION, type BaseEvent } from "@ag-ui/core";
import type { TextStreamPart, ToolSet } from "ai";

// AI SDK 的 fullStream → AG-UI 事件。这一层只做形状转换，不碰网络、不碰模型，
// 因为它是整套接入里最容易出错的地方（多一个/少一个 END、toolCallId 对不上），必须能脱离 IO 单测。
// 映射规则照 CopilotKit 自己的 BuiltInAgent（dist/agent/index.mjs 的 run()）对齐，
// 差别只有一处：文本用显式的 START/CONTENT/END，而不是 TEXT_MESSAGE_CHUNK 简写——
// 显式事件任何 AG-UI 客户端都能直接吃，不依赖客户端展开 chunk。

export type RunContext = { threadId: string; runId: string };

export function sseFrame(event: BaseEvent) {
    return `data: ${JSON.stringify(event)}\n\n`;
}

export function runStarted({ threadId, runId }: RunContext): BaseEvent {
    return { type: EventType.RUN_STARTED, threadId, runId, protocolVersion: PROTOCOL_VERSION } as BaseEvent;
}

export function runFailed({ threadId, runId }: RunContext, message: string, code?: string): BaseEvent {
    return { type: EventType.RUN_ERROR, threadId, runId, message, ...(code ? { code } : {}) } as BaseEvent;
}

export function runFinished({ threadId, runId }: RunContext, usage?: unknown): BaseEvent {
    return { type: EventType.RUN_FINISHED, threadId, runId, ...(usage ? { usage: [usage] } : {}) } as BaseEvent;
}

type ToolCallState = { toolName: string; started: boolean; hasArgsDelta: boolean; ended: boolean };

// 一个 run 一份状态：文本消息 id、reasoning 消息 id、每个工具调用的进度。
export function createEventMapper(context: RunContext, newId: () => string) {
    let messageId = newId();
    let reasoningId: string | null = null;
    let textOpen = false;
    const toolStates = new Map<string, ToolCallState>();

    const closeText = (): BaseEvent[] => {
        if (!textOpen) return [];
        textOpen = false;
        return [{ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent];
    };

    const closeReasoning = (): BaseEvent[] => {
        if (!reasoningId) return [];
        const closing = [{ type: EventType.REASONING_MESSAGE_END, messageId: reasoningId } as BaseEvent, { type: EventType.REASONING_END, messageId: reasoningId } as BaseEvent];
        reasoningId = null;
        return closing;
    };

    const toolState = (toolCallId: string, toolName?: string): ToolCallState => {
        const existing = toolStates.get(toolCallId);
        if (existing) {
            if (toolName) existing.toolName = toolName;
            return existing;
        }
        const created: ToolCallState = { toolName: toolName ?? "", started: false, hasArgsDelta: false, ended: false };
        toolStates.set(toolCallId, created);
        return created;
    };

    const startToolCall = (toolCallId: string, toolName: string): BaseEvent[] => {
        const state = toolState(toolCallId, toolName);
        if (state.started) return [];
        state.started = true;
        return [{ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: state.toolName, parentMessageId: messageId } as BaseEvent];
    };

    // 返回本 part 应产出的事件；末尾的 finish/error 用 terminal 标记，调用方据此结束流。
    const map = (part: TextStreamPart<ToolSet>): { events: BaseEvent[]; terminal?: BaseEvent } => {
        switch (part.type) {
            case "text-start":
                // 上游的 part.id 常是内容块序号（"0"），同一轮里会重复。
                // 直接拿来当 messageId 会把后一次回复拼进前一条助手消息。
                return { events: [] };
            case "text-delta": {
                const events = closeReasoning();
                if (!textOpen) {
                    messageId = newId();
                    textOpen = true;
                    events.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" } as BaseEvent);
                }
                events.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: part.text } as BaseEvent);
                return { events };
            }
            case "reasoning-start": {
                const events = closeText();
                reasoningId = part.id || newId();
                events.push({ type: EventType.REASONING_START, messageId: reasoningId } as BaseEvent);
                events.push({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: "reasoning" } as BaseEvent);
                return { events };
            }
            case "reasoning-delta": {
                if (!reasoningId) return { events: [] };
                if (!part.text) return { events: [] };
                return { events: [{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta: part.text } as BaseEvent] };
            }
            case "tool-input-start": {
                const events = [...closeReasoning(), ...closeText()];
                events.push(...startToolCall(part.id, part.toolName));
                return { events };
            }
            case "tool-input-delta": {
                const state = toolState(part.id);
                state.hasArgsDelta = true;
                return { events: [{ type: EventType.TOOL_CALL_ARGS, toolCallId: part.id, delta: part.delta } as BaseEvent] };
            }
            case "tool-call": {
                const events = [...closeReasoning(), ...closeText()];
                const state = toolState(part.toolCallId, part.toolName);
                events.push(...startToolCall(part.toolCallId, part.toolName));
                if (!state.hasArgsDelta && part.input !== undefined) {
                    const delta = serializeArguments(part.input);
                    if (delta) {
                        events.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: part.toolCallId, delta } as BaseEvent);
                        state.hasArgsDelta = true;
                    }
                }
                if (!state.ended) {
                    state.ended = true;
                    events.push({ type: EventType.TOOL_CALL_END, toolCallId: part.toolCallId } as BaseEvent);
                }
                return { events };
            }
            case "tool-result": {
                const state = toolStates.get(part.toolCallId);
                toolStates.delete(part.toolCallId);
                const content = safeStringify(part.output);
                return { events: [{ type: EventType.TOOL_CALL_RESULT, messageId: newId(), toolCallId: part.toolCallId, content, role: "tool", ...(state?.toolName ? { name: state.toolName } : {}) } as BaseEvent] };
            }
            case "tool-error": {
                toolStates.delete(part.toolCallId);
                const message = part.error instanceof Error ? part.error.message : String(part.error);
                return { events: [{ type: EventType.TOOL_CALL_RESULT, messageId: newId(), toolCallId: part.toolCallId, content: `Error: ${message}`, role: "tool" } as BaseEvent] };
            }
            case "finish": {
                const events = [...closeReasoning(), ...closeText()];
                return { events, terminal: runFinished(context, tokenUsage(part.totalUsage)) };
            }
            case "error": {
                const events = [...closeReasoning(), ...closeText()];
                return { events, terminal: runFailed(context, errorMessage(part.error)) };
            }
            case "abort": {
                const events = [...closeReasoning(), ...closeText()];
                return { events, terminal: { type: EventType.RUN_FINISHED, threadId: context.threadId, runId: context.runId, outcome: { type: "cancelled" } } as BaseEvent };
            }
            // start / start-step / finish-step / text-end / tool-input-end / source / file / raw / custom
            // 等不进 UI 的 part 直接忽略；未知类型也忽略，不因为新增 part 类型把整轮对话打断。
            default:
                return { events: [] };
        }
    };

    const finish = (): BaseEvent[] => [...closeReasoning(), ...closeText()];

    return { map, finish };
}

function errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return "模型调用失败";
}

function serializeArguments(input: unknown) {
    if (typeof input === "string") return input;
    return safeStringify(input, "");
}

function safeStringify(value: unknown, fallback = "null") {
    try {
        return JSON.stringify(value) ?? fallback;
    } catch {
        return fallback;
    }
}

function tokenUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number } | undefined) {
    if (!usage) return undefined;
    return {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
    };
}
