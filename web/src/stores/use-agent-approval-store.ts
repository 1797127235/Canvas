import { create } from "zustand";

import type { ToolRisk } from "@/lib/agent/tool-approval";
import { randomUuid } from "@/lib/utils";

// never：不再询问，直接把该工具从模型工具列表移除（available: false）。
// 拒绝永远是安全方向，所以 spend 类也允许永久拒绝。
export type ApprovalDecision = "once" | "session" | "always" | "deny" | "never";
type Resolution = ApprovalDecision | "cancel";

export type PendingApproval = {
    id: string;
    tool: string;
    risk: ToolRisk;
    summary: string;
};

// handler 在浏览器里 await 用户的决定，所以待审批项的 resolve 放在模块作用域，
// 不进 store state（函数不该被序列化，也不需要触发订阅）。
type Pending = { resolve: (resolution: Resolution) => void; detach: () => void };
const pending = new Map<string, Pending>();

// 唯一的收尾路径：移出队列、摘掉 abort 监听、结算 Promise。
// 三个调用方（用户点选、信号中止、面板卸载）都走这里，避免某条路径漏清理。
function settle(id: string, resolution: Resolution) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    useAgentApprovalStore.setState((state) => ({ queue: state.queue.filter((item) => item.id !== id) }));
    entry.detach();
    entry.resolve(resolution);
}

type AgentApprovalStore = {
    queue: PendingApproval[];
    decide: (id: string, decision: ApprovalDecision) => void;
};

export const useAgentApprovalStore = create<AgentApprovalStore>(() => ({
    queue: [],
    decide: (id, decision) => settle(id, decision),
}));

// 返回 Promise 而不是抛错/挂起：任何拒绝路径都必须给出结果，否则下一轮 run 会带上
// 没有结果的 tool call，部分上游直接 400。见 docs/specs/agent-tool-approval.md。
export function requestApproval(item: Omit<PendingApproval, "id">, signal?: AbortSignal) {
    return new Promise<Resolution>((resolve) => {
        if (signal?.aborted) {
            resolve("cancel");
            return;
        }
        const id = randomUuid();
        const onAbort = () => settle(id, "cancel");
        pending.set(id, {
            resolve,
            detach: () => signal?.removeEventListener("abort", onAbort),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        useAgentApprovalStore.setState((state) => ({ queue: [...state.queue, { ...item, id }] }));
    });
}

// 停止生成、切换会话、关闭面板时统一收尾。
export function cancelPendingApprovals() {
    for (const id of [...pending.keys()]) settle(id, "cancel");
}
