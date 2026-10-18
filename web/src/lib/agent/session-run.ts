import type { AbstractAgent, Message } from "@ag-ui/client";
import type { createSessionSaveQueue } from "./session-save-queue";
import { closeInterruptedTools } from "./interrupted-tools";

export function bindSessionPersistence(agent: AbstractAgent, options: {
    queue: ReturnType<typeof createSessionSaveQueue>;
    load: (threadId: string) => Promise<{ version: number; messages: Message[] }>;
    onBusy: (busy: boolean) => void;
    isActive: () => boolean;
}) {
    const original = agent.runAgent;
    let running = false;
    const uncertain = new Set<string>();
    const reconcile = async (threadId: string) => {
        const remote = await options.load(threadId);
        if (options.queue.isDirty(threadId, remote.messages)) throw new Error("对话发生冲突，本地消息已保留，请重新确认会话");
        options.queue.markSaved(threadId, remote.version, remote.messages);
        uncertain.delete(threadId);
    };
    const wrapped: AbstractAgent["runAgent"] = async (parameters, subscriber) => {
        if (running || !options.isActive()) throw new Error("会话正在保存或切换，请稍后重试");
        running = true;
        options.onBusy(true);
        const threadId = agent.threadId;
        try {
            if (uncertain.has(threadId)) await reconcile(threadId);
            const repaired = closeInterruptedTools(agent.messages);
            if (repaired.length !== agent.messages.length) agent.setMessages(repaired);
            await options.queue.flush(threadId, structuredClone(agent.messages));
            uncertain.add(threadId);
            options.queue.suspend(threadId);
            try {
                return await original.call(agent, { ...parameters, forwardedProps: { ...parameters?.forwardedProps, sessionVersion: options.queue.version(threadId) } }, subscriber);
            } catch (error) {
                const interrupted = closeInterruptedTools(agent.messages);
                if (interrupted.length !== agent.messages.length) agent.setMessages(interrupted);
                throw error;
            } finally {
                await reconcile(threadId);
                // 下轮工具续跑会在相同入口保存浏览器执行结果。
                await options.queue.flush(threadId, structuredClone(agent.messages));
            }
        } finally {
            running = false;
            options.onBusy(false);
        }
    };
    agent.runAgent = wrapped;
    return () => { if (agent.runAgent === wrapped) agent.runAgent = original; };
}
