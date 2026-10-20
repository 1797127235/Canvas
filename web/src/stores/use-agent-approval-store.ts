import { create } from "zustand";

import type { ToolRisk } from "@/lib/agent/tool-approval";
import { randomUuid } from "@/lib/utils";

export type ApprovalDecision = "once" | "session" | "always" | "deny";
type Resolution = ApprovalDecision | "cancel";

export type PendingApproval = {
    id: string;
    tool: string;
    risk: ToolRisk;
    summary: string;
};

// handler 在浏览器里 await 用户的决定，所以待审批项的 resolve 放在模块作用域，
// 不进 store state（函数不该被序列化，也不需要触发订阅）。
const resolvers = new Map<string, (resolution: Resolution) => void>();

type AgentApprovalStore = {
    queue: PendingApproval[];
    decide: (id: string, decision: ApprovalDecision) => void;
};

export const useAgentApprovalStore = create<AgentApprovalStore>(() => ({
    queue: [],
    decide: (id, decision) => {
        const resolve = resolvers.get(id);
        if (!resolve) return;
        // 先把待审批项从队列里摘掉再唤醒 handler，否则卡片会一直停在界面上。
        drop(id);
        resolve(decision);
    },
}));

function drop(id: string) {
    resolvers.delete(id);
    useAgentApprovalStore.setState((state) => ({ queue: state.queue.filter((item) => item.id !== id) }));
}

// 返回 Promise 而不是抛错/挂起：任何拒绝路径都必须给出结果，否则下一轮 run 会带上
// 没有结果的 tool call，部分上游直接 400。见 docs/specs/agent-tool-approval.md。
export function requestApproval(item: Omit<PendingApproval, "id">, signal?: AbortSignal) {
    return new Promise<Resolution>((resolve) => {
        if (signal?.aborted) {
            resolve("cancel");
            return;
        }
        const id = randomUuid();
        const onAbort = () => {
            drop(id);
            resolve("cancel");
        };
        resolvers.set(id, (resolution) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(resolution);
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        useAgentApprovalStore.setState((state) => ({ queue: [...state.queue, { ...item, id }] }));
    });
}

// 停止生成、切换会话、关闭面板时统一收尾。
export function cancelPendingApprovals() {
    for (const [id, resolve] of [...resolvers]) {
        resolvers.delete(id);
        resolve("cancel");
    }
    useAgentApprovalStore.setState({ queue: [] });
}
