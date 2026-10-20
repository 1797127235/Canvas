import { expect, test } from "bun:test";

import { AGENT_ATTACHMENT_LIMIT, AGENT_ATTACHMENT_MAX_BYTES, buildUserMessageContent, buildUserMessageMetadata, readMessageAttachments, rejectAttachment, type AgentAttachment } from "../src/lib/agent/attachments";
import type { Message } from "@ag-ui/core";

const attachment = (storageKey: string): AgentAttachment => ({ storageKey, name: "ref.png", mimeType: "image/png", bytes: 1024 });

test("only images within the size and count limits are accepted", () => {
    expect(rejectAttachment({ type: "image/png", size: 1024 }, 0)).toBeNull();
    expect(rejectAttachment({ type: "video/mp4", size: 1024 }, 0)).toBe("type");
    expect(rejectAttachment({ type: "image/png", size: AGENT_ATTACHMENT_MAX_BYTES + 1 }, 0)).toBe("size");
    expect(rejectAttachment({ type: "image/png", size: 1024 }, AGENT_ATTACHMENT_LIMIT)).toBe("count");
});

test("text without attachments keeps the plain string shape", () => {
    expect(buildUserMessageContent("你好", [])).toBe("你好");
    expect(buildUserMessageMetadata([])).toBeUndefined();
});

test("attachments become image parts carrying the remote identity", () => {
    expect(buildUserMessageContent("参考这张", [attachment("remote:a")])).toEqual([
        { type: "text", text: "参考这张" },
        { type: "image", id: "remote:a", source: { type: "url", value: "remote:a", mimeType: "image/png" } },
    ]);
    expect(buildUserMessageContent("", [attachment("remote:a")])).toEqual([{ type: "image", id: "remote:a", source: { type: "url", value: "remote:a", mimeType: "image/png" } }]);
});

test("metadata round-trips attachments and rejects malformed entries", () => {
    const attachments = [attachment("remote:a")];
    const message = { id: "m1", role: "user", content: "x", metadata: buildUserMessageMetadata(attachments) } as Message;
    expect(readMessageAttachments(message)).toEqual(attachments);
    expect(readMessageAttachments({ id: "m2", role: "user", content: "x" } as Message)).toEqual([]);
    expect(readMessageAttachments({ id: "m3", role: "user", content: "x", metadata: { attachments: [{ storageKey: "image:a" }, { storageKey: "remote:b", name: "b", mimeType: "image/png", bytes: 1 }] } } as Message)).toEqual([
        { storageKey: "remote:b", name: "b", mimeType: "image/png", bytes: 1 },
    ]);
});
