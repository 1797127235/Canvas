import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RunAgentInput } from "@ag-ui/core";
import { stepCountIs, streamText, type ModelMessage } from "ai";

import { chatModel } from "../gateway/index.js";
import type { ModelBinding } from "../gateway/contracts.js";
import { createEventMapper, runFailed, runFinished, runStarted, sseFrame } from "./events.js";
import { inlineRemoteImages, type AgentMediaReader } from "./attachments.js";
import { buildSystemPrompt, toModelMessages, toToolSet } from "./messages.js";
import { prepareAgentContext } from "./compaction/prepare.js";
import type { CompactionBudget } from "./compaction/context.js";
import type { SessionStore } from "./sessions/store.js";

// 系统提示词固定在这里：它决定助手扮演什么角色，属于产品行为，不交给客户端覆盖。
// 画布摘要由客户端通过 AG-UI 的 context 传进来，拼在后面的同名段落里。
const INSTRUCTIONS = [
    "你是无限画布（infinite-canvas）里的创作助手，帮用户在这张画布上搭建图像与视频的生成流程。",
    "画布由节点和连线组成：文本节点放提示词，图片/视频/音频节点放素材与结果，配置节点保存生成参数，节点之间的连线表示数据流向（上游节点的内容会作为下游的参考素材）。",
    "先依据当前画布摘要回答概览；需要全文或相邻连线时调用 get_node_detail。用户要求操作时只调用对应画布工具，并以工具结果为准，不声称未成功的操作已完成。",
    "update_node 目前只支持改标题、提示词、文本节点内容和位置；delete_nodes 会同时移除相关连线；连线前确认方向符合画布数据流。",
    "新增一组节点时用 apply_graph 一次提交节点及它们之间的连线；不需要改动画布时正常对话，不要为了显得有用而强行建节点。",
    "用户上传的附件会在消息文本里标注 remote:<id>；要把附件放到画布时直接用这个 id 作为 apply_graph 的 storageKey，不要臆造资源地址。你只能看到图片内容，其它类型的附件只有 id。",
    "回答和操作都使用简体中文，简洁直接，不要复述已经说过的话。"
].join("\n");

// 一轮对话最多几步。工具由浏览器执行，每步之间要往返一次，步数给 10 步足够「先看画布、再建图、再检查」的常见组合，
// 又不至于让一次失败的工具调用无限重试。
const MAX_STEPS = 10;

export type AgentRunOptions = {
    model: ModelBinding;
    apiKey: string;
    input: RunAgentInput;
    signal: AbortSignal;
    response: Response;
    sessions: SessionStore;
    userId: string;
    projectId: string;
    budget?: CompactionBudget;
    readMedia?: AgentMediaReader;
};

// 一次 run：把 AG-UI 输入换成 AI SDK 调用，把 fullStream 逐块写成 SSE。
// 工具在浏览器执行，所以这里传给 streamText 的 ToolSet 全部没有 execute：
// AI SDK 遇到这种工具调用就结束本轮，前端跑完把结果作为下一轮消息带回来。
export async function streamAgentRun(options: AgentRunOptions) {
    const { model, apiKey, input, signal, response } = options;
    const context = { threadId: input.threadId, runId: input.runId };
    const mapper = createEventMapper(context, randomUUID);
    const write = (event: unknown) => {
        if (!response.writableEnded) response.write(sseFrame(event as never));
    };

    response.status(200).type("text/event-stream");
    response.setHeader("Cache-Control", "no-store");
    // 让 nginx 不做响应缓冲：否则整段回答会在结束时才一次性吐给浏览器。
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    write(runStarted(context));

    try {
        const prepared = await prepareAgentContext({ ...options, instructions: buildSystemPrompt(INSTRUCTIONS, input.context) });
        write({ type: "CUSTOM", name: "session_version", value: { threadId: input.threadId, runId: input.runId, version: prepared.version } });
        const instructions = prepared.instructions;
        const messages: ModelMessage[] = toModelMessages(await inlineRemoteImages(prepared.messages, options.readMedia));
        const tools = toToolSet(input.tools);
        const result = streamText({
            model: chatModel(model, apiKey),
            instructions,
            messages,
            ...(tools ? { tools, stopWhen: stepCountIs(MAX_STEPS) } : {}),
            ...(options.budget ? { maxOutputTokens: options.budget.maxOutputTokens } : {}),
            maxRetries: 0,
            abortSignal: signal,
        });
        for await (const part of result.fullStream) {
            const { events, terminal } = mapper.map(part);
            events.forEach(write);
            if (terminal) {
                write(terminal);
                response.end();
                return;
            }
        }
        // fullStream 正常结束但没收到 finish（部分上游不发）：补上收尾与结束事件。
        mapper.finish().forEach(write);
        if (!response.writableEnded) {
            write(runFinished(context));
            response.end();
        }
    } catch (error) {
        if (signal.aborted || response.writableEnded) return;
        write(runFailed(context, error instanceof Error ? error.message : "模型调用失败"));
        response.end();
    }
}
