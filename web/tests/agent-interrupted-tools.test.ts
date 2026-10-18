import { expect, test } from "bun:test";
import type { Message } from "@ag-ui/client";
import { closeInterruptedTools } from "../src/lib/agent/interrupted-tools";

const call = { id: "c", type: "function" as const, function: { name: "apply_graph", arguments: '{"nodes":' } };
test("preserves incomplete tool arguments and inserts a failure before a new user message", () => {
    const messages: Message[] = [{ id: "u1", role: "user", content: "create" }, { id: "a1", role: "assistant", toolCalls: [call] }, { id: "u2", role: "user", content: "continue" }];
    const result = closeInterruptedTools(messages);
    expect(result).toHaveLength(4);
    expect(result[1]).toEqual(messages[1]);
    expect(result[2].role).toBe("tool");
    expect(String(result[2].content)).toContain("未确认执行完成");
    expect(result[3]).toEqual(messages[2]);
    expect(messages).toHaveLength(3);
    expect(closeInterruptedTools(result)).toEqual(result);
});

test("does not invent failure results for a completed tool group", () => {
    const messages: Message[] = [{ id: "a", role: "assistant", toolCalls: [call] }, { id: "t", role: "tool", toolCallId: "c", content: "done" }];
    expect(closeInterruptedTools(messages)).toEqual(messages);
});
