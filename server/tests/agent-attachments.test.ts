import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Message } from "@ag-ui/core";
import type { Pool } from "pg";
import sharp from "sharp";

import { inlineRemoteImages } from "../src/agent/attachments.js";
import { toModelMessages } from "../src/agent/messages.js";
import { readAccountMediaImageBytes } from "../src/media.js";

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

// 模型看到的图片应当来自 2048 预览档：原图只在预览生成失败时兜底。
const mediaDirectory = async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-media-"));
    const userId = randomUUID();
    const mediaId = randomUUID();
    const objectKey = `${userId}/${mediaId}`;
    await mkdir(join(directory, userId), { recursive: true });
    return { directory, userId, mediaId, objectKey };
};

const mediaPool = (userId: string, mediaId: string, row?: { object_key: string; mime_type: string }) =>
    ({ query: async (sql: string, values: unknown[]) => {
        if (!sql.includes("FROM user_media")) return { rows: [] };
        if (values[1] !== userId) return { rows: [] };
        return { rows: values[0] === mediaId && row ? [row] : [] };
    } }) as unknown as Pool;

test("model images come from the 2048 preview tier and reuse the stored preview", async () => {
    const { directory, userId, mediaId, objectKey } = await mediaDirectory();
    try {
        const original = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: "#336699" } }).png().toBuffer();
        await writeFile(join(directory, objectKey), original);
        const database = mediaPool(userId, mediaId, { object_key: objectKey, mime_type: "image/png" });
        const read = () => readAccountMediaImageBytes(database, { directory }, userId, mediaId, 2048);

        const first = await read();
        assert.equal(first.mimeType, "image/webp");
        const meta = await sharp(first.bytes).metadata();
        assert.equal(Math.max(meta.width ?? 0, meta.height ?? 0), 2048);
        assert.ok(first.bytes.length < original.length);

        // 第二次直接命中已落盘的预览，不会再走一遍 sharp。
        const second = await read();
        assert.deepEqual(second.bytes, first.bytes);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("a preview generation failure still hands the original bytes over", async () => {
    const { directory, userId, mediaId, objectKey } = await mediaDirectory();
    try {
        const original = Buffer.from("not-really-an-image");
        await writeFile(join(directory, objectKey), original);
        const database = mediaPool(userId, mediaId, { object_key: objectKey, mime_type: "image/png" });
        const result = await readAccountMediaImageBytes(database, { directory }, userId, mediaId, 2048);
        assert.equal(result.mimeType, "image/png");
        assert.deepEqual(result.bytes, original);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("non-image media is rejected without reading any bytes", async () => {
    const { directory, userId, mediaId, objectKey } = await mediaDirectory();
    try {
        await writeFile(join(directory, objectKey), Buffer.alloc(1024));
        const database = mediaPool(userId, mediaId, { object_key: objectKey, mime_type: "video/mp4" });
        await assert.rejects(readAccountMediaImageBytes(database, { directory }, userId, mediaId, 2048), /不是图片/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("another account's media cannot be read", async () => {
    const { directory, userId, mediaId, objectKey } = await mediaDirectory();
    try {
        await writeFile(join(directory, objectKey), Buffer.from("secret"));
        const database = mediaPool(userId, mediaId, { object_key: objectKey, mime_type: "image/png" });
        await assert.rejects(readAccountMediaImageBytes(database, { directory }, userId, randomUUID(), 2048), /不存在或不属于当前账号/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
