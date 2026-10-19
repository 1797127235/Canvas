import type { Message } from "@ag-ui/client";

import { randomUuid } from "@/lib/utils";

// 只补明确的中断结果，保留原调用与参数；绝不据此执行或重放工具。
export function closeInterruptedTools(messages: Message[]): Message[] {
    const result: Message[] = [];
    const pending = new Set<string>();
    const close = () => {
        for (const toolCallId of pending) result.push({ id: randomUuid(), role: "tool", toolCallId, content: "工具调用因请求中断，未确认执行完成；不要自动重放此操作。" });
        pending.clear();
    };
    for (const message of messages) {
        if (message.role !== "tool" && message.role !== "reasoning" && message.role !== "activity") close();
        result.push(message);
        if (message.role === "assistant") for (const call of message.toolCalls ?? []) pending.add(call.id);
        if (message.role === "tool") pending.delete(message.toolCallId);
    }
    close();
    return result;
}
