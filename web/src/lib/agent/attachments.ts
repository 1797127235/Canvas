import type { ContentPart, Message } from "@ag-ui/core";

// 助手附件只保存资源身份（remote:<uuid>），字节留在服务端媒体库。
// 会话表有体积上限，把 base64 写进消息几次就会爆。
export type AgentAttachment = {
    storageKey: string;
    name: string;
    mimeType: string;
    bytes: number;
};

export const AGENT_ATTACHMENT_LIMIT = 4;
// 单张 10 MB 是产品口径，不是代理上限：上传走 /api/media（nginx client_max_body_size 0），
// 不受 /api/ 的 8 MiB JSON 上限约束，这里只是提前拦住离谱大图。服务端 MAX_IMAGE_BYTES 必须同步。
export const AGENT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type AttachmentRejection = "type" | "size" | "count";

export function rejectAttachment(file: { type: string; size: number }, current: number): AttachmentRejection | null {
    if (!file.type.startsWith("image/")) return "type";
    if (file.size > AGENT_ATTACHMENT_MAX_BYTES) return "size";
    if (current >= AGENT_ATTACHMENT_LIMIT) return "count";
    return null;
}

// 没有附件时保持字符串内容：历史消息、标题提取和压缩逻辑都不需要区分数组形态。
export function buildUserMessageContent(text: string, attachments: AgentAttachment[]): string | ContentPart[] {
    if (!attachments.length) return text;
    const parts: ContentPart[] = text ? [{ type: "text", text }] : [];
    for (const attachment of attachments) {
        parts.push({ type: "image", id: attachment.storageKey, source: { type: "url", value: attachment.storageKey, mimeType: attachment.mimeType } });
    }
    return parts;
}

export function buildUserMessageMetadata(attachments: AgentAttachment[]) {
    return attachments.length ? { attachments } : undefined;
}

export function readMessageAttachments(message: Message): AgentAttachment[] {
    const metadata = message.metadata;
    if (!metadata || typeof metadata !== "object") return [];
    const value = (metadata as { attachments?: unknown }).attachments;
    if (!Array.isArray(value)) return [];
    return value.filter(isAttachment);
}

function isAttachment(value: unknown): value is AgentAttachment {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.storageKey === "string" && item.storageKey.startsWith("remote:") && typeof item.name === "string" && typeof item.mimeType === "string" && typeof item.bytes === "number";
}
