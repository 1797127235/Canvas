import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";

import { inlineRemoteImages } from "../src/agent/attachments.js";
import { toModelMessages } from "../src/agent/messages.js";

const imageMessage = (id: string, mediaIds: string[]): Message =>
    ({
        id,
        role: "user",
        content: [
            { type: "text", text: "看看这些图" },
            ...mediaIds.map((mediaId) => ({ type: "image", source: { type: "url", value: `remote:${mediaId}`, mimeType: "image/png" } })),
        ],
    }) as Message;

const reader = (bytes = "aGk=") => async () => ({ bytes: Buffer.from(bytes, "base64"), mimeType: "image/png" });

test("resolves remote images to bytes and leaves the identity in the text", async () => {
    const [message] = await inlineRemoteImages([imageMessage("m1", ["a"])], reader());
    assert.equal(message.role, "user");
    assert.deepEqual(message.content, [
        { type: "text", text: "看看这些图" },
        { type: "image", source: { type: "data", value: "aGk=", mimeType: "image/png" } },
        { type: "text", text: "用户上传的附件：remote:a" },
    ]);
});

test("inlines only the newest four images but keeps every identity", async () => {
    const [message] = await inlineRemoteImages([imageMessage("m1", ["1", "2", "3", "4", "5", "6"])], reader());
    assert.ok(Array.isArray(message.content));
    const data = message.content.filter((part) => part.type === "image" && part.source.type === "data");
    assert.equal(data.length, 4);
    const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    for (const id of ["1", "2", "3", "4", "5", "6"]) assert.match(text, new RegExp(`remote:${id}`));
});

test("drops the image but keeps the identity when the media cannot be read", async () => {
    const [message] = await inlineRemoteImages([imageMessage("m1", ["gone"])], async () => {
        throw new Error("不存在");
    });
    assert.deepEqual(message.content, [
        { type: "text", text: "看看这些图" },
        { type: "text", text: "用户上传的附件：remote:gone" },
    ]);
});

test("without a reader only the identity is kept", async () => {
    const [message] = await inlineRemoteImages([imageMessage("m1", ["a"])]);
    assert.deepEqual(message.content, [
        { type: "text", text: "看看这些图" },
        { type: "text", text: "用户上传的附件：remote:a" },
    ]);
});

test("converted attachments reach the model as image parts", async () => {
    const messages = await inlineRemoteImages([imageMessage("m1", ["a"])], reader());
    assert.deepEqual(toModelMessages(messages), [
        {
            role: "user",
            content: [
                { type: "text", text: "看看这些图" },
                { type: "image", image: "aGk=", mediaType: "image/png" },
                { type: "text", text: "用户上传的附件：remote:a" },
            ],
        },
    ]);
});

test("leaves non-remote images and plain text messages untouched", async () => {
    const messages = [
        { id: "m1", role: "user", content: "纯文本" },
        {
            id: "m2",
            role: "user",
            content: [{ type: "image", source: { type: "url", value: "https://example.com/a.png", mimeType: "image/png" } }],
        },
    ] as Message[];
    assert.deepEqual(await inlineRemoteImages(messages, reader()), messages);
});
