import type { Message } from "@ag-ui/core";

// 返回工具组已闭合的位置，切点只能选在这些位置；不允许孤立或重复结果。
export function safeBoundaries(messages: Message[]): Set<number> {
    const ids = new Set<string>();
    const calls = new Set<string>();
    const pending = new Set<string>();
    const safe = new Set([0]);
    messages.forEach((message, index) => {
        if (!message.id || ids.has(message.id)) throw new Error("消息 ID 缺失或重复");
        ids.add(message.id);
        if (pending.size && message.role !== "tool" && message.role !== "reasoning" && message.role !== "activity") throw new Error("工具调用缺少对应结果");
        if (message.role === "assistant") for (const call of message.toolCalls ?? []) {
            if (!call.id || calls.has(call.id)) throw new Error("工具调用 ID 重复或无效");
            calls.add(call.id);
            pending.add(call.id);
        }
        if (message.role === "tool" && !pending.delete(message.toolCallId)) throw new Error("工具结果缺少对应调用");
        if (!pending.size) safe.add(index + 1);
    });
    if (pending.size) throw new Error("工具调用尚未完成");
    return safe;
}
