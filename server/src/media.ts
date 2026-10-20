import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, resolve, sep } from "node:path";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { Client } from "minio";
import sharp from "sharp";

import { requireUser } from "./identity/auth-middleware.js";

type ByteRange = { start: number; end: number };
type MediaStore = { put(key: string, body: Readable, mimeType: string): Promise<void>; get(key: string, range?: ByteRange): Promise<Readable>; remove(key: string): Promise<void> };
export type MediaOptions = { client?: Client; bucket?: string; directory?: string };

// 画布预览分档：客户端按「需要显示的最长边」取满足需求的最小档，画布上永不加载原图。
const CANVAS_PREVIEW_PROFILE = {
    version: "canvas-preview-v2",
    quality: 82,
} as const;
export const CANVAS_PREVIEW_TIERS = [512, 1024, 2048];
const DEFAULT_CANVAS_PREVIEW_TIER = CANVAS_PREVIEW_TIERS[0];
const previewJobs = new Map<string, Promise<Buffer>>();
const posterJobs = new Map<string, Promise<Buffer>>();
const VIDEO_POSTER_PROFILE = {
    version: "video-poster-canvas-v1",
    maxLongEdge: 1024,
    quality: 82,
} as const;
const MAX_IMAGE_INPUT_PIXELS = 40_000_000;

export async function createCanvasPreview(input: Readable, maxLongEdge: number) {
    const output = sharp({ limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
        .rotate()
        .resize({ width: maxLongEdge, height: maxLongEdge, fit: "inside", withoutEnlargement: true })
        .webp({ quality: CANVAS_PREVIEW_PROFILE.quality });
    const chunks: Buffer[] = [];
    const collector = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    await pipeline(input, output, collector);
    return Buffer.concat(chunks);
}

async function createStoredPreview(store: MediaStore, objectKey: string, tier: number, input: () => Promise<Readable>) {
    const key = previewObjectKey(objectKey, tier);
    let job = previewJobs.get(key);
    if (!job) {
        job = input().then((stream) => createCanvasPreview(stream, tier));
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

function previewObjectKey(objectKey: string, tier: number) {
    return `${objectKey}.preview.${CANVAS_PREVIEW_PROFILE.version}.${tier}.webp`;
}

function previewObjectKeys(objectKey: string) {
    return CANVAS_PREVIEW_TIERS.map((tier) => previewObjectKey(objectKey, tier));
}

// 请求可以指定需要的显示边长；取满足需求的最小档，超上限时封顶，避免回落到原图。
function previewTier(requested: unknown) {
    const value = Number(requested);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_CANVAS_PREVIEW_TIER;
    return CANVAS_PREVIEW_TIERS.find((tier) => tier >= value) ?? CANVAS_PREVIEW_TIERS[CANVAS_PREVIEW_TIERS.length - 1];
}

function posterObjectKey(objectKey: string) {
    return `${objectKey}.poster.${VIDEO_POSTER_PROFILE.version}.webp`;
}

async function createVideoPoster(input: Readable) {
    const process = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], { stdio: ["pipe", "pipe", "pipe"] });
    const outputPromise = readStreamBytes(process.stdout);
    const errorPromise = readStreamBytes(process.stderr);
    try {
        await pipeline(input, process.stdin);
        const [png, errorOutput] = await Promise.all([outputPromise, errorPromise]);
        const exitCode = await new Promise<number | null>((resolve) => process.once("close", resolve));
        if (exitCode !== 0 || !png.length) throw new Error(`视频海报生成失败${errorOutput.length ? `: ${errorOutput.toString("utf8").trim()}` : ""}`);
        return sharp(png, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS })
            .resize({ width: VIDEO_POSTER_PROFILE.maxLongEdge, height: VIDEO_POSTER_PROFILE.maxLongEdge, fit: "inside", withoutEnlargement: true })
            .webp({ quality: VIDEO_POSTER_PROFILE.quality })
            .toBuffer();
    } catch (error) {
        process.kill();
        throw error;
    }
}

async function createStoredPoster(store: MediaStore, objectKey: string, input: () => Promise<Readable>) {
    const key = posterObjectKey(objectKey);
    let job = posterJobs.get(key);
    if (!job) {
        job = input().then(createVideoPoster);
        posterJobs.set(key, job);
    }
    try {
        const poster = await job;
        await store.put(key, Readable.from(poster), "image/webp");
        return poster;
    } finally {
        if (posterJobs.get(key) === job) posterJobs.delete(key);
    }
}

// 供生成任务等服务端流程落盘媒体：写入与 /api/media 上传相同的存储和 user_media 表。
// 顺带返回宽高（sharp.metadata 只读文件头，不解码整图），让客户端不必为了拿尺寸再把字节取回去。
export async function storeAccountMedia(database: Pool, options: MediaOptions, userId: string, bytes: Buffer, mimeType: string) {
    const store = mediaStore(options);
    if (!store) throw new Error("媒体存储尚未配置");
    const id = randomUUID();
    const objectKey = `${userId}/${id}`;
    await store.put(objectKey, Readable.from(bytes), mimeType);
    await database.query("INSERT INTO user_media (id, user_id, object_key, mime_type, byte_size) VALUES ($1, $2, $3, $4, $5)", [id, userId, objectKey, mimeType, bytes.length]);
    const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_INPUT_PIXELS }).metadata().catch(() => null);
    if (metadata?.width && metadata.height) return { id, mimeType, bytes: bytes.length, width: metadata.width, height: metadata.height };
    return { id, mimeType, bytes: bytes.length };
}

// 回收无人引用的账号媒体。四重保险，宁可少删不能误删：
// ① 只动创建超过宽限期的媒体，刚生成、刚上传的永不入选；
// ② 以 user_media_references 为索引（保存工作区时重建）；
// ③ 再核对工作区与生成历史的原文——引用表是后来才加的，
//    旧数据首次上线时表是空的，只看表会把还在用的媒体删光；
// ④ 助手对话（user_agent_threads）同样按原文核对，它不在引用表里。
export const MEDIA_GRACE_DAYS = 7;

export async function clearUnusedMedia(database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return 0;
    const result = await database.query<{ id: string; object_key: string }>(
        `DELETE FROM user_media m
         WHERE m.created_at < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
           AND NOT EXISTS (SELECT 1 FROM user_media_references r WHERE r.user_id = m.user_id AND r.media_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM user_workspaces w WHERE w.user_id = m.user_id AND w.data::text LIKE '%remote:' || m.id::text || '%')
           AND NOT EXISTS (SELECT 1 FROM user_generation_history h WHERE h.user_id = m.user_id AND h.data::text LIKE '%remote:' || m.id::text || '%')
           -- 画布助手的对话也会引用素材（建节点时带 storageKey、生成结果回填），
           -- 不查这一处会在宽限期后把对话里还在用的图删掉。
           AND NOT EXISTS (SELECT 1 FROM user_agent_threads t WHERE t.user_id = m.user_id AND t.messages::text LIKE '%remote:' || m.id::text || '%')
         RETURNING m.id, m.object_key`,
        [MEDIA_GRACE_DAYS],
    );
    for (const row of result.rows) {
        await store.remove(row.object_key).catch(() => undefined);
        await Promise.all(previewObjectKeys(row.object_key).map((key) => store.remove(key).catch(() => undefined)));
        await store.remove(posterObjectKey(row.object_key)).catch(() => undefined);
    }
    return result.rows.length;
}

// 视频等大媒体的流式落盘：不把整个文件读进 api 进程内存，边收边写存储并统计体积。
export async function storeAccountMediaStream(database: Pool, options: MediaOptions, userId: string, body: Readable, mimeType: string) {
    const store = mediaStore(options);
    if (!store) throw new Error("媒体存储尚未配置");
    const id = randomUUID();
    const objectKey = `${userId}/${id}`;
    let size = 0;
    const counter = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(null, chunk); } });
    try {
        await store.put(objectKey, body.pipe(counter), mimeType);
        await database.query("INSERT INTO user_media (id, user_id, object_key, mime_type, byte_size) VALUES ($1, $2, $3, $4, $5)", [id, userId, objectKey, mimeType, size]);
    } catch (error) {
        await store.remove(objectKey).catch(() => undefined);
        throw error;
    }
    return { id, mimeType, bytes: size };
}

// 归属校验只此一份：查不到统一报错，不区分「不存在」与「不属于当前账号」，避免探测他人素材。
async function findAccountMedia(database: Pool, userId: string, mediaId: string) {
    const result = await database.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM user_media WHERE id = $1 AND user_id = $2", [mediaId, userId]);
    const row = result.rows[0];
    if (!row) throw new Error("参考素材不存在或不属于当前账号");
    return row;
}

// 素材字节的完整读取入口：生成流程按 remote:<uuid> 取原图字节，与 /api/media 的读取共用同一套归属校验。
export async function readAccountMediaBytes(database: Pool, options: MediaOptions, userId: string, mediaId: string) {
    const store = mediaStore(options);
    if (!store) throw new Error("媒体存储尚未配置");
    const row = await findAccountMedia(database, userId, mediaId);
    return { bytes: await readStreamBytes(await store.get(row.object_key)), mimeType: row.mime_type };
}

// 给模型看的图片字节：走画布预览分档（调用方指定档位，助手用 2048），不把原图整块读进进程内存。
// 原图存下 6000×4000 时，直读原图等于每轮每张几十 MB Buffer 加更大的 base64，而上游本来就会把长边
// 压到 ~1568，预览档不丢它要用的细节。预览首次生成后落盘可复用，不会每轮重算。
export async function readAccountMediaImageBytes(database: Pool, options: MediaOptions, userId: string, mediaId: string, tier: number) {
    const store = mediaStore(options);
    if (!store) throw new Error("媒体存储尚未配置");
    const row = await findAccountMedia(database, userId, mediaId);
    // 视频/音频不进模型；为了不把整段视频读进内存，这里直接按类型拒绝。
    if (!row.mime_type.startsWith("image/")) throw new Error("该素材不是图片");
    const previewKey = previewObjectKey(row.object_key, tier);
    try {
        return { bytes: await readStreamBytes(await store.get(previewKey)), mimeType: "image/webp" };
    } catch {
        // 这一档还没生成过，下面现生成。
    }
    try {
        return { bytes: await createStoredPreview(store, row.object_key, tier, () => store.get(row.object_key)), mimeType: "image/webp" };
    } catch {
        // 预览生成失败（格式古怪、sharp 不支持）退回原图：解析不了的大图也比让助手看不到强。
        return { bytes: await readStreamBytes(await store.get(row.object_key)), mimeType: row.mime_type };
    }
}

const MEDIA_LINK_TTL_SECONDS = 10 * 60;
function mediaLinkSignature(secret: string, id: string, expires: number) {
    return createHmac("sha256", secret).update(`${id}.${expires}`).digest("base64url");
}
export function signedMediaUrl(origin: string, secret: string, id: string, now = Date.now()) {
    const expires = Math.floor(now / 1000) + MEDIA_LINK_TTL_SECONDS;
    const token = mediaLinkSignature(secret, id, expires);
    return `${origin}/api/media/${id}?expires=${expires}&token=${token}`;
}
function validMediaLink(secret: string, id: string, expires: string | undefined, token: string | undefined) {
    const expiry = Number(expires);
    if (!secret || !Number.isSafeInteger(expiry) || expiry < Math.floor(Date.now() / 1000) || !token) return false;
    const expected = Buffer.from(mediaLinkSignature(secret, id, expiry));
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createMediaRouter(database: Pool, options: MediaOptions, linkSecret = "") {
    const router = Router();
    router.get("/media/:id", (request, response, next) => {
        const { expires, token } = request.query;
        if (typeof expires !== "string" || typeof token !== "string") return next();
        if (!validMediaLink(linkSecret, request.params.id, expires, token)) return response.status(401).json({ error: { code: "MEDIA_LINK_INVALID", message: "媒体链接无效或已过期" } });
        return readSignedMedia(request, response, database, options);
    });
    router.use(requireUser(database));
    router.post("/media", (request, response) => uploadMedia(request, response, database, options));
    router.get("/media/:id/preview", (request, response) => readPreview(request, response, database, options));
    router.get("/media/:id/poster", (request, response) => readPoster(request, response, database, options));
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

    const tier = previewTier(request.query.w);
    const previewKey = previewObjectKey(row.object_key, tier);
    let bytes: Buffer;
    let mimeType = "image/webp";
    let preview = true;
    try {
        bytes = await readStreamBytes(await store.get(previewKey));
    } catch {
        try {
            bytes = await createStoredPreview(store, row.object_key, tier, () => store.get(row.object_key));
        } catch {
            // 预览生成失败时退回原图，画布会重新解码大图，但至少不显示破图。
            bytes = await readStreamBytes(await store.get(row.object_key));
            mimeType = row.mime_type;
            preview = false;
        }
    }
    const etag = `"${request.params.id}-${preview ? `${CANVAS_PREVIEW_PROFILE.version}-${tier}` : "original"}"`;
    response.type(mimeType).set({ "Cache-Control": "private, no-cache", ETag: etag });
    if (request.header("if-none-match") === etag) return response.status(304).end();
    return response.set("Content-Length", String(bytes.length)).send(bytes);
}

async function readPoster(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM user_media WHERE id = $1 AND user_id = $2", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "媒体不存在" } });
    if (!row.mime_type.startsWith("video/")) return response.status(415).json({ error: { code: "MEDIA_POSTER_UNSUPPORTED", message: "该媒体不支持视频海报" } });

    let bytes: Buffer;
    try {
        bytes = await readStreamBytes(await store.get(posterObjectKey(row.object_key)));
    } catch {
        try {
            bytes = await createStoredPoster(store, row.object_key, () => store.get(row.object_key));
        } catch {
            return response.status(503).json({ error: { code: "MEDIA_POSTER_UNAVAILABLE", message: "视频海报暂时不可用" } });
        }
    }
    const etag = `"${request.params.id}-${VIDEO_POSTER_PROFILE.version}"`;
    response.type("image/webp").set({ "Cache-Control": "private, no-cache", ETag: etag });
    if (request.header("if-none-match") === etag) return response.status(304).end();
    return response.set("Content-Length", String(bytes.length)).send(bytes);
}

async function readSignedMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    const store = mediaStore(options);
    if (!store) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string; mime_type: string; byte_size: string | number }>("SELECT object_key, mime_type, byte_size FROM user_media WHERE id = $1", [request.params.id]);
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "媒体不存在" } });
    const bytes = Number(row.byte_size);
    response.type(row.mime_type).set({ "Cache-Control": "private, no-store", "Content-Length": String(bytes) });
    const stream = await store.get(row.object_key);
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
        await Promise.all(previewObjectKeys(row.object_key).map((key) => store.remove(key).catch(() => undefined)));
        await store.remove(posterObjectKey(row.object_key)).catch(() => undefined);
    }
    return response.status(204).end();
}
