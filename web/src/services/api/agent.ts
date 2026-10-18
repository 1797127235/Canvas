import type { Message } from "@ag-ui/client";

import { useUserStore } from "@/stores/use-user-store";

export type AgentThread = { threadId: string; version: number; messages: Message[] };

// 会话读写：一个画布项目一条会话，threadId 由服务端签发。
// 保存带 If-Match-Version，冲突返回 409——和画布工作区同一套乐观锁交互。
export async function fetchAgentThread(projectId: string, signal?: AbortSignal): Promise<AgentThread> {
    const response = await fetch(`/api/agent/threads/${encodeURIComponent(projectId)}`, { credentials: "same-origin", signal, headers: accountHeaders() });
    if (!response.ok) throw await threadError(response, "对话读取失败");
    return (await response.json()) as AgentThread;
}

export async function saveAgentThread(projectId: string, version: number, messages: Message[], signal?: AbortSignal): Promise<{ version: number }> {
    const response = await fetch(`/api/agent/threads/${encodeURIComponent(projectId)}`, {
        method: "PUT",
        credentials: "same-origin",
        signal,
        headers: { "Content-Type": "application/json", "If-Match-Version": String(version), ...accountHeaders() },
        body: JSON.stringify({ messages }),
    });
    if (!response.ok) throw await threadError(response, "对话保存失败");
    return (await response.json()) as { version: number };
}

// 「新对话」：清空消息并换一个 threadId，旧 threadId 立即失效。
export async function resetAgentThread(projectId: string): Promise<{ threadId: string; version: number }> {
    const response = await fetch(`/api/agent/threads/${encodeURIComponent(projectId)}`, { method: "DELETE", credentials: "same-origin", headers: accountHeaders() });
    if (!response.ok) throw await threadError(response, "新对话开启失败");
    return (await response.json()) as { threadId: string; version: number };
}

function accountHeaders(): Record<string, string> {
    const userId = useUserStore.getState().user?.id;
    return userId ? { "X-Account-Id": userId } : {};
}

async function threadError(response: Response, fallback: string) {
    if (response.status === 409) return new Error("对话已在其他页面更新，请重新打开助手");
    if (response.status === 413) return new Error("对话内容过长，请开一个新对话");
    try {
        const payload = (await response.json()) as { error?: { message?: string } };
        return new Error(payload.error?.message || fallback);
    } catch {
        return new Error(fallback);
    }
}
