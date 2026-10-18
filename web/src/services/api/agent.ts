import type { Message } from "@ag-ui/client";

import { useUserStore } from "@/stores/use-user-store";

export class AgentThreadApiError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
    get retryable() { return this.status === 429 || this.status >= 500; }
}

export type AgentThread = { threadId: string; title: string; version: number; messages: Message[]; updatedAt: string };

export async function fetchAgentThreads(projectId: string, signal?: AbortSignal): Promise<AgentThread[]> {
    const response = await fetch(threadUrl(projectId), { credentials: "same-origin", signal, headers: accountHeaders() });
    if (!response.ok) throw await threadError(response, "对话读取失败");
    return (await response.json()) as AgentThread[];
}

export async function fetchAgentThread(projectId: string, threadId: string, signal?: AbortSignal): Promise<AgentThread> {
    const response = await fetch(`${threadUrl(projectId)}/${encodeURIComponent(threadId)}`, { credentials: "same-origin", signal, headers: accountHeaders() });
    if (!response.ok) throw await threadError(response, "对话读取失败");
    return (await response.json()) as AgentThread;
}

export async function createAgentThread(projectId: string): Promise<AgentThread> {
    const response = await fetch(threadUrl(projectId), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...accountHeaders() },
        body: JSON.stringify({}),
    });
    if (!response.ok) throw await threadError(response, "新对话开启失败");
    return (await response.json()) as AgentThread;
}

export async function saveAgentThread(projectId: string, threadId: string, version: number, messages: Message[]): Promise<{ version: number; title: string }> {
    const response = await fetch(`${threadUrl(projectId)}/${encodeURIComponent(threadId)}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "If-Match-Version": String(version), ...accountHeaders() },
        body: JSON.stringify({ messages }),
    });
    if (!response.ok) throw await threadError(response, "对话保存失败");
    return (await response.json()) as { version: number; title: string };
}

export async function deleteAgentThread(projectId: string, threadId: string): Promise<void> {
    const response = await fetch(`${threadUrl(projectId)}/${encodeURIComponent(threadId)}`, { method: "DELETE", credentials: "same-origin", headers: accountHeaders() });
    if (!response.ok) throw await threadError(response, "对话删除失败");
}

function threadUrl(projectId: string) {
    return `/api/agent/threads/${encodeURIComponent(projectId)}`;
}

function accountHeaders(): Record<string, string> {
    const userId = useUserStore.getState().user?.id;
    return userId ? { "X-Account-Id": userId } : {};
}

async function threadError(response: Response, fallback: string) {
    if (response.status === 409) return new AgentThreadApiError(409, "对话已在其他页面更新，本地消息已保留，请重新确认会话");
    if (response.status === 413) return new AgentThreadApiError(413, "对话内容过长，请开一个新对话");
    try {
        const payload = (await response.json()) as { error?: { message?: string } };
        return new AgentThreadApiError(response.status, payload.error?.message || fallback);
    } catch {
        return new AgentThreadApiError(response.status, fallback);
    }
}
