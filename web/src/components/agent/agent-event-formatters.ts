import type { AgentChatItem, AgentMessageAttachment } from "@/stores/use-agent-store";
import type { AgentChatAttachment } from "./agent-chat-message";

export function agentMessageToChatMessage(item: AgentChatItem) {
    return { ...item, meta: item.role === "user" || item.role === "assistant" ? undefined : item.meta, attachments: item.attachments?.map(agentAttachmentToChatAttachment) };
}

export function agentAttachmentToChatAttachment(item: AgentMessageAttachment): AgentChatAttachment {
    return { id: item.id, name: item.name, url: item.dataUrl || item.url };
}

export function registerLiveAgentTurn(event: { replayed?: boolean; threadId?: string; thread_id?: string; turnId?: string; turn_id?: string }, authoritativeTurns: ReadonlySet<string>, liveTurns: Set<string>) {
    const threadId = event.threadId || event.thread_id || "";
    const turnId = event.turnId || event.turn_id || "";
    const key = threadId && turnId ? `${threadId}\0${turnId}` : "";
    if (event.replayed && key && authoritativeTurns.has(key)) return false;
    if (key) liveTurns.add(key);
    return true;
}

export function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return JSON.stringify(value, null, 2);
}

export function stringText(value: unknown) {
    return typeof value === "string" ? value : "";
}

export function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export function agentMessageId(threadId: string, turnId: string, itemId: string) {
    return `${threadId}:${turnId}:${itemId}`;
}

export function scopeChatItem(item: AgentChatItem, threadId: string, turnId: string) {
    const scopeTurnId = turnId || "pending";
    const prefix = `${threadId || "local"}:${scopeTurnId}:`;
    const sourceItemId = item.itemId || (item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id);
    const itemId = item.role === "user" ? "synthetic:user" : sourceItemId;
    return { ...item, id: agentMessageId(threadId || "local", scopeTurnId, itemId), itemId, threadId, turnId };
}

export function bindPendingTurnMessages(messages: AgentChatItem[], threadId: string, turnId: string) {
    const index = messages.findLastIndex((item) => item.role === "user" && item.threadId === threadId && !item.turnId);
    if (index < 0) return messages;
    return messages.map((item, itemIndex) => (itemIndex === index ? scopeChatItem(item, threadId, turnId) : item));
}

export function upsertAgentMessage(messages: AgentChatItem[], item: AgentChatItem) {
    const index = messages.findIndex((current) => current.id === item.id);
    if (index < 0) return [...messages, item];
    const current = messages[index];
    const next = { ...current, ...item, ...mergeLocalMessageMetadata(current, item) };
    return messages.map((message, itemIndex) => (itemIndex === index ? next : message));
}

export function mergeAgentMessages(snapshot: AgentChatItem[], current: AgentChatItem[], threadId: string, liveTurnKeys: ReadonlySet<string>) {
    let messages = [...snapshot];
    current
        .filter((item) => item.threadId === threadId)
        .forEach((item) => {
            const live = Boolean(item.turnId && liveTurnKeys.has(`${threadId}\0${item.turnId}`));
            const index = messages.findIndex((message) => message.id === item.id);
            if (index < 0) {
                if (!item.turnId || live) messages = upsertAgentMessage(messages, item);
                return;
            }
            const history = messages[index];
            const metadata = mergeLocalMessageMetadata(history, item);
            const next = live ? { ...history, ...item, ...metadata } : { ...history, ...metadata };
            messages = messages.map((message, itemIndex) => (itemIndex === index ? next : message));
        });
    return messages;
}

export function normalizeHistoryMessages(messages: AgentChatItem[]) {
    return messages
        .filter((item) => (normalizeText(item.text) || item.role === "tool") && item.itemId && item.threadId && item.turnId)
        .map(({ streamId: _streamId, ...item }) => scopeChatItem({ ...item, text: normalizeText(item.text) } as AgentChatItem, item.threadId!, item.turnId!));
}

function mergeLocalMessageMetadata(current: AgentChatItem, incoming: AgentChatItem) {
    return {
        attachments: incoming.attachments || current.attachments,
        canvasReferences: incoming.canvasReferences || current.canvasReferences,
    };
}

export function mergeStreamText(prefix: string, incoming: string) {
    if (!prefix || incoming.startsWith(prefix)) return incoming || prefix;
    if (!incoming || prefix.startsWith(incoming)) return prefix;
    return incoming.length >= prefix.length ? incoming : prefix;
}
