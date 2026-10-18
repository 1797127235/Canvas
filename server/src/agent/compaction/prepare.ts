import { isDeepStrictEqual } from "node:util";
import type { RunAgentInput } from "@ag-ui/core";
import { generateText } from "ai";

import { chatModel } from "../../ai/generation.js";
import type { CatalogModel } from "../../catalog/catalog.js";
import { safeBoundaries } from "../sessions/message-boundaries.js";
import { AgentThreadError, type SessionStore } from "../sessions/store.js";
import { compactContext, CompactionError, SUMMARY_INSTRUCTIONS, summaryMessage, type CompactionBudget } from "./context.js";

export type PrepareOptions = {
    sessions: SessionStore; userId: string; projectId: string; input: RunAgentInput;
    model: CatalogModel; apiKey: string; signal: AbortSignal; instructions: string;
    budget?: CompactionBudget; summarize?: (prompt: string) => Promise<string>;
};

export async function prepareAgentContext(options: PrepareOptions) {
    const { sessions, userId, projectId, input, signal, instructions, budget } = options;
    const session = await sessions.getForCompaction(userId, projectId, input.threadId);
    const expected = input.forwardedProps?.sessionVersion;
    if (!Number.isSafeInteger(expected) || expected !== session.version || !isDeepStrictEqual(session.messages.filter((m) => m.role !== "activity"), input.messages)) throw new AgentThreadError("conflict", "对话版本或消息已改变，请先保存并重新确认会话");
    const summarize = options.summarize ?? (async (prompt: string) => {
        const result = await generateText({
            model: chatModel(options.model, options.apiKey), instructions: `${SUMMARY_INSTRUCTIONS} 摘要最多约 ${Math.max(1, Math.floor(budget!.summaryTokens / 4))} 个字符，优先保留未完成目标和明确约束。`, prompt,
            maxOutputTokens: budget!.summaryTokens, maxRetries: 0,
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        });
        if (result.finishReason !== "stop") throw new CompactionError("摘要生成未完整结束，请重试");
        return result.text;
    });
    let summary = session.compactionSummary;
    let messages = input.messages;
    let version = session.version;
    if (budget) {
        const compacted = await compactContext({ messages, summary, boundary: session.coveredThroughMessageId, instructions, tools: input.tools, budget, signal, summarize });
        if (compacted.changed) {
            signal.throwIfAborted();
            version = await sessions.updateCompactionState(userId, projectId, input.threadId, version, compacted.summary!, compacted.boundary!);
        }
        summary = compacted.summary;
        messages = compacted.messages;
    } else {
        const safe = safeBoundaries(messages);
        if ((summary === null) !== (session.coveredThroughMessageId === null)) throw new CompactionError("摘要状态不完整");
        if (session.coveredThroughMessageId) {
            const start = messages.findIndex((m) => m.id === session.coveredThroughMessageId) + 1;
            if (!start || !safe.has(start)) throw new CompactionError("压缩边界无效");
            messages = messages.slice(start);
        }
    }
    signal.throwIfAborted();
    const historical = summaryMessage(summary);
    return { instructions, messages: historical ? [historical, ...messages] : messages, version, compacted: version !== session.version };
}
