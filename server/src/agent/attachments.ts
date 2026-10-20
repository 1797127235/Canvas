import type { ContentPart, Message } from "@ag-ui/core";

// 助手附件只传身份（remote:<uuid>），字节在服务端按账号读出后再交给上游。
// 这里负责把最近几条消息里的附件身份换成上游能读的 base64。
export type AgentMediaReader = (mediaId: string) => Promise<{ bytes: Buffer; mimeType: string }>;

const REMOTE_PREFIX = "remote:";
// 必须与前端 AGENT_ATTACHMENT_MAX_BYTES 一致。正常路径走 2048 预览档只有几百 KB，
// 这个上限只在预览生成失败、退回原图时起作用。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// 一次 run 最多内联 16 MB 原始字节（base64 后约 21 MB）。走预览档时远达不到，留作兜底。
const MAX_INLINE_TOTAL_BYTES = 16 * 1024 * 1024;
// 只内联最近 4 张：历史附件每轮重新 base64 会持续放大请求体和上游计费。
const MAX_INLINE_IMAGES = 4;

type RemoteImage = { message: number; part: number; mediaId: string };

export async function inlineRemoteImages(messages: Message[], readMedia?: AgentMediaReader): Promise<Message[]> {
    const slots = remoteImages(messages);
    if (!slots.length) return messages;

    // 文档顺序即时间顺序，取最后 N 个就是最近的附件。
    const inline = new Set(slots.slice(-MAX_INLINE_IMAGES).map(keyOf));
    const resolved = new Map<string, { value: string; mimeType: string; size: number } | null>();
    let total = 0;
    for (const slot of slots) {
        if (!inline.has(keyOf(slot)) || resolved.has(slot.mediaId)) continue;
        const image = await readImage(slot.mediaId, readMedia);
        if (!image || total + image.size > MAX_INLINE_TOTAL_BYTES) {
            resolved.set(slot.mediaId, null);
            continue;
        }
        total += image.size;
        resolved.set(slot.mediaId, image);
    }

    return messages.map((message, messageIndex) => {
        if (message.role !== "user" || typeof message.content === "string") return message;
        const ids = slots.filter((slot) => slot.message === messageIndex).map((slot) => `${REMOTE_PREFIX}${slot.mediaId}`);
        if (!ids.length) return message;
        const parts: ContentPart[] = [];
        message.content.forEach((part) => {
            if (part.type !== "image" || part.source.type !== "url" || !part.source.value.startsWith(REMOTE_PREFIX)) {
                parts.push(part);
                return;
            }
            const image = resolved.get(part.source.value.slice(REMOTE_PREFIX.length));
            // 读不到（越权、超限、存储未配置）就不送这张图，但不能因此丢掉整轮对话。
            if (image) parts.push({ ...part, source: { type: "data", value: image.value, mimeType: image.mimeType } });
        });
        // 模型看不到 part id，把身份写进文本，下一轮才能用 storageKey 把附件放上画布。
        parts.push({ type: "text", text: `用户上传的附件：${ids.join("、")}` });
        return { ...message, content: parts };
    });
}

function keyOf(slot: RemoteImage) {
    return `${slot.message}:${slot.part}`;
}

function remoteImages(messages: Message[]): RemoteImage[] {
    const slots: RemoteImage[] = [];
    messages.forEach((message, messageIndex) => {
        if (message.role !== "user" || typeof message.content === "string") return;
        message.content.forEach((part, partIndex) => {
            if (part.type !== "image" || part.source.type !== "url" || !part.source.value.startsWith(REMOTE_PREFIX)) return;
            slots.push({ message: messageIndex, part: partIndex, mediaId: part.source.value.slice(REMOTE_PREFIX.length) });
        });
    });
    return slots;
}

async function readImage(mediaId: string, readMedia?: AgentMediaReader) {
    if (!readMedia) return null;
    try {
        const { bytes, mimeType } = await readMedia(mediaId);
        if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !mimeType.startsWith("image/")) return null;
        return { value: bytes.toString("base64"), mimeType, size: bytes.length };
    } catch {
        return null;
    }
}
