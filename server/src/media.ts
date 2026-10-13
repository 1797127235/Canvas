import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";import { pipeline } from "node:stream/promises";
import { dirname, resolve, sep } from "node:path";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { Client } from "minio";
import sharp from "sharp";

import { requireUser } from "./identity/auth-middleware.js";

type ByteRange = { start: number; end: number };
type MediaStore = { put(key: string, body: Readable, mimeType: string): Promise<void>; get(key: string, range?: ByteRange): Promise<Readable>; remove(key: string): Promise<void> };
export type MediaOptions = { client?: Client; bucket?: string; directory?: string };

const CANVAS_PREVIEW_PROFILE = {
    version: "canvas-preview-v1",
    maxLongEdge: 768,
    quality: 82,
} as const;
const previewJobs = new Map<string, Promise<Buffer>>();
const MAX_IMAGE_INPUT_PIXELS = 40_000_000;

async function createCanvasPreview(input: Readable) {
    const output = sharp({ limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
        .rotate()
        .resize({ width: CANVAS_PREVIEW_PROFILE.maxLongEdge, height: CANVAS_PREVIEW_PROFILE.maxLongEdge, fit: "inside", withoutEnlargement: true })
        .webp({ quality: CANVAS_PREVIEW_PROFILE.quality });
    const chunks: Buffer[] = [];
    const collector = new Transform({ transform(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(null, chunk); } });
    await pipeline(input, output, collector);
    return Buffer.concat(chunks);
}

async function createStoredPreview(store: MediaStore, objectKey: string, input: () => Promise<Readable>) {
    const key = `${objectKey}.preview.${CANVAS_PREVIEW_PROFILE.version}.webp`;
    let job = previewJobs.get(key);
    if (!job) {
        job = input().then(createCanvasPreview);
        previewJobs.set(key, job);
    }
    try {
        const preview = await job;
        await store.put(key, Readable.from(preview), "image/webp");
        return preview;
    } finally {
        if (previewJobs.get(key) === job) previewJobs.delete(key);
    }
}

function previewObjectKey(objectKey: string) {
    return `${objectKey}.preview.${CANVAS_PREVIEW_PROFILE.version}.webp`;
}

// 供生成任务等服务端流程落盘媒体：写入与 /api/media 上传相同的存储和 user_media 表。
export async function storeAccountMedia(database: Pool, options: MediaOptions, userId: string, bytes: Buffer, mimeType: string) {
    const store = mediaStore(options);
    if (!store) throw new Error("媒体存储尚未配置");
    const id = randomUUID();
    const objectKey = `${userId}/${id}`;
    await store.put(objectKey, Readable.from(bytes), mimeType);
    await database.query("INSERT INTO user_media (id, user_id, object_key, mime_type, byte_size) VALUES ($1, $2, $3, $4, $5)", [id, userId, objectKey, mimeType, bytes.length]);
    return { id, mimeType, bytes: bytes.length };
}

export function createMediaRouter(database: Pool, options: MediaOptions) {
    const router = Router();
    router.use(requireUser(database));
    router.post("/media", (request, response) => uploadMedia(request, response, database, options));
    router.get("/media/:id/preview", (request, response) => readPreview(request, response, database, options));
    router.get("/media/:id", (request, response) => readMedia(request, response, database, options));
    router.delete("/media/:id", (request, response) => deleteMedia(request, response, database, options));
    return router;
}

function mediaStore(options: MediaOptions): MediaStore | null {
    if (options.client && options.bucket) {
        const client = options.client;
        const bucket = options.bucket;
        return { put: (key, body, mimeType) => client.putObject(bucket, key, body, undefined, { "Content-Type": mimeType }).then(() => undefined), get: (key, range) => range ? client.getPartialObject(bucket, key, range.start, range.end - range.start + 1) : client.getObject(bucket, key), remove: (key) => client.removeObject(bucket, key) };
    }
    if (!options.directory) return null;
    const root = resolve(options.directory);
    const file = (key: string) => {
        const path = resolve(root, key);
        if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Invalid media key");
        return path;
    };
    return {
        put: async (key, body) => { const path = file(key); await mkdir(dirname(path), { recursive: true }); await pipeline(body, createWriteStream(path)); },
        get: async (key, range) => createReadStream(file(key), range),
        remove: (key) => rm(file(key), { force: true }),
    };
}

async function uploadMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const mimeType = request.header("content-type") || "application/octet-stream";
    const id = randomUUID();
    const userId = response.locals.user.id;
    const objectKey = `${userId}/${id}`;
    let bytes = 0;
    const body = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
    const producer = pipeline(request, body);
    const consumer = Promise.resolve().then(() => store.put(objectKey, body, mimeType)).catch((error) => {
        body.destroy(error instanceof Error ? error : new Error("媒体写入失败"));
        throw error;
    });
    try {
        await Promise.all([producer, consumer]);
        await database.query("INSERT INTO user_media (id, user_id, object_key, mime_type, byte_size) VALUES ($1, $2, $3, $4, $5)", [id, userId, objectKey, mimeType, bytes]);
    } catch (error) {
        body.destroy();
        // 等写入端退出后再删除，避免清理后仍有文件/对象写入。
        await Promise.allSettled([producer, consumer]);
        await store.remove(objectKey).catch(() => undefined);
        throw error;
    }
    return response.status(201).json({ id, mimeType, bytes });
}

async function readStreamBytes(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function readPreview(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM user_media WHERE id = $1 AND user_id = $2", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "媒体不存在" } });
    if (!row.mime_type.startsWith("image/")) return response.status(415).json({ error: { code: "MEDIA_PREVIEW_UNSUPPORTED", message: "该媒体不支持图片预览" } });

    const previewKey = previewObjectKey(row.object_key);
    let bytes: Buffer;
    let mimeType = "image/webp";
    let preview = true;
    try {
        bytes = await readStreamBytes(await store.get(previewKey));
    } catch {
        try {
            bytes = await createStoredPreview(store, row.object_key, () => store.get(row.object_key));
        } catch {
            bytes = await readStreamBytes(await store.get(row.object_key));
            mimeType = row.mime_type;
            preview = false;
        }
    }
    const etag = `"${request.params.id}-${preview ? CANVAS_PREVIEW_PROFILE.version : "original"}"`;
    response.type(mimeType).set({ "Cache-Control": "private, no-cache", ETag: etag });
    if (request.header("if-none-match") === etag) return response.status(304).end();
    return response.set("Content-Length", String(bytes.length)).send(bytes);
}

async function readMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string; mime_type: string; byte_size: string | number }>("SELECT object_key, mime_type, byte_size FROM user_media WHERE id = $1 AND user_id = $2", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "媒体不存在" } });
    const bytes = Number(row.byte_size);
    response.type(row.mime_type).set({ "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
    let range: ByteRange | undefined;
    if (request.method === "GET" && request.header("range") && !request.header("if-range")) {
        const ranges = request.range(bytes);
        if (ranges === -1) return response.status(416).set({ "Content-Range": `bytes */${bytes}`, "Content-Length": "0" }).end();
        // 不支持 multipart；忽略多段、格式错误或非 bytes 的 Range，返回完整响应。
        if (ranges && typeof ranges !== "number" && ranges.type === "bytes" && ranges.length === 1) {
            range = ranges[0];
            if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end >= bytes) {
                return response.status(416).set({ "Content-Range": `bytes */${bytes}`, "Content-Length": "0" }).end();
            }
        }
    }
    response.set("Content-Length", String(range ? range.end - range.start + 1 : bytes));
    if (range) response.status(206).set("Content-Range", `bytes ${range.start}-${range.end}/${bytes}`);
    if (request.method === "HEAD") return response.end();
    const stream = await store.get(row.object_key, range);
    const close = () => stream.destroy();
    response.on("close", close);
    try {
        if (response.destroyed) return;
        await pipeline(stream, response);
    } finally {
        response.off("close", close);
        stream.destroy();
    }
}

async function deleteMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string }>("DELETE FROM user_media WHERE id = $1 AND user_id = $2 RETURNING object_key", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (row) {
        await store.remove(row.object_key);
        await store.remove(previewObjectKey(row.object_key)).catch(() => undefined);
    }
    return response.status(204).end();
}
