import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import sharp from "sharp";

import { requireUser } from "./identity/auth-middleware.js";
import { accountModels, resolveModel, type Catalog } from "./catalog/catalog.js";
import { readUserApiKey } from "./credentials.js";

const imageData = z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);
const videoData = z.string().regex(/^data:video\/(mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/);
const audioData = z.string().regex(/^data:audio\/(mpeg|mp3|wav|ogg|webm);base64,[A-Za-z0-9+/]+={0,2}$/);
const imageInput = z.strictObject({
    prompt: z.string().min(1), n: z.number().int().positive().optional(),
    size: z.string().optional(), quality: z.string().optional(), background: z.string().optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(), images: z.array(imageData).optional(),
});
const videoInput = z.strictObject({
    prompt: z.string().min(1), seconds: z.string().optional(), size: z.string().optional(), resolution_name: z.string().optional(),
    generate_audio: z.boolean().optional(), watermark: z.boolean().optional(), mode: z.enum(["frames", "reference"]).optional(),
    images: z.array(imageData).optional(), videos: z.array(videoData).optional(), audios: z.array(audioData).optional(),
});
const textInput = z.strictObject({
    messages: z.array(z.strictObject({
        role: z.enum(["system", "user", "assistant"]),
        content: z.union([z.string(), z.array(z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("text"), text: z.string() }),
            z.strictObject({ type: z.literal("image_url"), image_url: z.strictObject({ url: z.string() }) }),
        ]))]),
    })).min(1),
    stream: z.boolean().optional(), reasoning_effort: z.string().optional(),
});
const speechInput = z.strictObject({
    input: z.string().min(1), voice: z.string().min(1), response_format: z.string().optional(),
    speed: z.number().positive().optional(), instructions: z.string().optional(),
});
const inputSchema = z.discriminatedUnion("capability", [
    z.strictObject({ capability: z.literal("image"), modelId: z.string().min(1), input: imageInput }),
    z.strictObject({ capability: z.literal("video"), modelId: z.string().min(1), input: videoInput }),
    z.strictObject({ capability: z.literal("text"), modelId: z.string().min(1), input: textInput }),
    z.strictObject({ capability: z.literal("audio"), modelId: z.string().min(1), input: speechInput }),
]);
const taskIdSchema = z.string().uuid();
const taskResponseSchema = z.object({ id: z.string().min(1), status: z.string().optional() });
type GenerationOptions = { catalog: Catalog; encryptionKey?: string };
type UpstreamResponse = { status: number; contentType: string; body: Buffer };

export function createGenerationRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    // Restrict authentication middleware to these routes, not every subsequent API router.
    router.post("/generations", requireUser(database), async (request, response) => {
        const parsed = inputSchema.safeParse(request.body);
        if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        const apiKey = await readUserApiKey(database, response.locals.user.id, options.encryptionKey);
        if (!apiKey) return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } });
        let models;
        try { models = await accountModels(options.catalog, apiKey); }
        catch { return upstreamFailure(response, 502); }
        const model = resolveModel({ models }, parsed.data.modelId, parsed.data.capability);
        if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
        if (parsed.data.capability === "text" || parsed.data.capability === "audio") {
            const target = upstreamTarget(model.baseUrl, parsed.data.capability === "text" ? "chat/completions" : "audio/speech");
            if (!target) return unavailable(response);
            const body = Buffer.from(JSON.stringify({ ...parsed.data.input, model: model.upstreamModel }));
            if (parsed.data.capability === "text" && parsed.data.input.stream) return streamText(target, apiKey, body, response);
            const upstream = await requestUpstream(target, apiKey, body, "application/json");
            if (upstream.status < 200 || upstream.status >= 300) return upstreamFailure(response, upstream.status, upstream.body);
            return response.status(200).type(upstream.contentType || "application/octet-stream").send(upstream.body);
        }
        const input = parsed.data.input;
        const isVideo = parsed.data.capability === "video";
        const isEdit = !isVideo && Boolean(input.images?.length);
        const path = isVideo ? "videos" : isEdit ? "images/edits" : "images/generations";
        const url = upstreamTarget(model.baseUrl, path);
        if (!url) return unavailable(response);
        let body: Buffer;
        let contentType: string;
        if (isVideo) {
            // 视频网关只收 JSON：时长/分辨率/比例/参考图，参考图仅支持单张 image.{url}。
            const video = parsed.data.input as z.infer<typeof videoInput>;
            const payload: Record<string, unknown> = { model: model.upstreamModel, prompt: video.prompt };
            const duration = Number(video.seconds);
            if (duration > 0) payload.duration = duration;
            if (video.resolution_name) payload.resolution = video.resolution_name;
            if (video.size) payload.aspect_ratio = aspectRatio(video.size);
            if (video.generate_audio !== undefined) payload.generate_audio = video.generate_audio;
            if (video.watermark !== undefined) payload.watermark = video.watermark;
            // 单张走 image；多张走 reference_images（上游拒绝 images 数组，reference_images 实测可用）。
            const references = await Promise.all((video.images || []).map(image => normalizeVideoImage(image)));
            if (references.length === 1) payload.image = { url: references[0] };
            else if (references.length > 1) payload.reference_images = references.map(url => ({ url }));
            body = Buffer.from(JSON.stringify(payload));
            contentType = "application/json";
        } else if (isEdit) {
            const form = new FormData();
            form.set("model", model.upstreamModel);
            for (const [key, value] of Object.entries(input)) {
                if (value !== undefined && !Array.isArray(value)) form.set(key, String(value));
            }
            const images = input.images || [];
            for (const image of images) appendMedia(form, images.length === 1 ? "image" : "image[]", image);
            // Use Node's standard multipart encoder, including boundary generation.
            const encoded = new Response(form);
            body = Buffer.from(await encoded.arrayBuffer());
            contentType = encoded.headers.get("content-type")!;
        } else {
            const { images: _images, ...params } = input;
            body = Buffer.from(JSON.stringify({ ...params, model: model.upstreamModel }));
            contentType = "application/json";
        }
        const upstream = await requestUpstream(url, apiKey, body, contentType);
        if (upstream.status < 200 || upstream.status >= 300) return upstreamFailure(response, upstream.status, upstream.body);
        if (isVideo) {
            const task = parseTaskResponse(upstream.body);
            if (!task) return upstreamFailure(response, 502);
            const id = randomUUID();
            await database.query(
                "INSERT INTO user_generation_tasks (id, user_id, upstream_id, base_url, model_id) VALUES ($1, $2, $3, $4, $5)",
                [id, response.locals.user.id, task.id, model.baseUrl, model.id],
            );
            return response.status(201).json({ id, status: task.status || "queued" });
        }
        return response.status(200).type("application/json").send(upstream.body);
    });
    const historyKind = z.enum(["image", "video"]);
    router.get("/generation-history/:kind", requireUser(database), async (request, response) => {
        const kind = historyKind.safeParse(request.params.kind);
        if (!kind.success) return taskNotFound(response);
        const rows = await database.query<{ data: unknown }>("SELECT data FROM user_generation_history WHERE user_id = $1 AND kind = $2", [response.locals.user.id, kind.data]);
        return response.json({ logs: rows.rows.map(row => row.data) });
    });
    router.put("/generation-history/:kind/:id", requireUser(database), async (request, response) => {
        const kind = historyKind.safeParse(request.params.kind);
        const data = z.record(z.string(), z.unknown()).safeParse(request.body);
        if (!kind.success || !data.success || data.data.id !== request.params.id) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成记录无效" } });
        await database.query("INSERT INTO user_generation_history (user_id, kind, id, data) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, kind, id) DO UPDATE SET data = EXCLUDED.data", [response.locals.user.id, kind.data, request.params.id, data.data]);
        return response.status(204).end();
    });
    router.delete("/generation-history/:kind/:id", requireUser(database), async (request, response) => {
        const kind = historyKind.safeParse(request.params.kind);
        if (!kind.success) return taskNotFound(response);
        await database.query("DELETE FROM user_generation_history WHERE user_id = $1 AND kind = $2 AND id = $3", [response.locals.user.id, kind.data, request.params.id]);
        return response.status(204).end();
    });
    router.get("/generations/:id", requireUser(database), (request, response) => readTask(request, response, database, options, false));
    router.get("/generations/:id/content", requireUser(database), (request, response) => readTask(request, response, database, options, true));
    return router;
}

async function readTask(request: Request, response: Response, database: Pool, options: GenerationOptions, content: boolean) {
    const parsed = taskIdSchema.safeParse(request.params.id);
    if (!parsed.success) return taskNotFound(response);
    const task = await database.query<{ upstream_id: string; base_url: string }>(
        "SELECT upstream_id, base_url FROM user_generation_tasks WHERE id = $1 AND user_id = $2", [parsed.data, response.locals.user.id],
    );
    const row = task.rows[0];
    if (!row) return taskNotFound(response);
    const apiKey = await readUserApiKey(database, response.locals.user.id, options.encryptionKey);
    if (!apiKey) return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } });
    const path = `videos/${encodeURIComponent(row.upstream_id)}${content ? "/content" : ""}`;
    const target = upstreamTarget(row.base_url, path);
    if (!target) return unavailable(response);
    const upstream = await requestUpstream(target, apiKey);
    if (upstream.status < 200 || upstream.status >= 300) return upstreamFailure(response, upstream.status, upstream.body);
    return response.status(200).type(content ? "video/mp4" : "application/json").send(upstream.body);
}

function streamText(target: URL, apiKey: string, body: Buffer, response: Response): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = target.protocol === "https:" ? httpsRequest : httpRequest;
        const client = request(target, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream", "Content-Length": body.length },
        }, (incoming) => {
            const status = incoming.statusCode || 502;
            if (status < 200 || status >= 300) {
                incoming.resume();
                upstreamFailure(response, status);
                resolve();
                return;
            }
            response.type(incoming.headers["content-type"] || "text/event-stream");
            response.flushHeaders();
            incoming.on("error", reject);
            incoming.on("aborted", () => reject(new Error("Upstream response aborted")));
            incoming.on("end", resolve);
            incoming.pipe(response);
        });
        response.on("close", () => { client.destroy(); resolve(); });
        client.on("error", reject);
        client.end(body);
    });
}

function upstreamTarget(baseUrl: string, path: string) {
    try {
        const base = new URL(baseUrl);
        const target = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
        if (target.search) return null;
        return ["https:", "http:"].includes(base.protocol) && !base.username && !base.password && target.origin === base.origin ? target : null;
    } catch {
        return null;
    }
}

function appendMedia(form: FormData, field: string, dataUrl: string) {
    const [header, base64] = dataUrl.split(",");
    const mimeType = header.slice(5, -7);
    const bytes = Buffer.from(base64, "base64");
    form.append(field, new Blob([bytes], { type: mimeType }), `reference.${mimeType.split("/")[1]}`);
}

function parseTaskResponse(body: Buffer) {
    try {
        const payload = JSON.parse(body.toString("utf8"));
        const raw = (payload.data || payload) as { id?: unknown; request_id?: unknown; status?: unknown };
        const parsed = taskResponseSchema.safeParse({ ...raw, id: raw.id || raw.request_id });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function unavailable(response: Response) { return response.status(503).json({ error: { code: "GENERATION_NOT_CONFIGURED", message: "生成服务尚未配置" } }); }
function taskNotFound(response: Response) { return response.status(404).json({ error: { code: "GENERATION_NOT_FOUND", message: "生成任务不存在" } }); }
function upstreamFailure(response: Response, status: number, body?: Buffer) {
    const unauthorized = status === 401 || status === 403;
    return response.status(502).json({ error: { code: unauthorized ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_ERROR", message: unauthorized ? "上游认证失败，请检查账号 API Key" : readUpstreamError(body) || "上游生成失败，请检查模型和参数" } });
}
function readUpstreamError(body?: Buffer) {
    if (!body?.length) return "";
    try {
        const payload = JSON.parse(body.toString("utf8")) as { error?: unknown; message?: unknown };
        const error = payload.error;
        const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message || payload.message;
        return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : "";
    } catch {
        return "";
    }
}
// 把像素尺寸折算成上游接受的标准比例，无法解析时不传而不是猜。
function aspectRatio(size: string) {
    const [width, height] = size.split("x").map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
    return ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9"].reduce((best, current) => {
        const [currentWidth, currentHeight] = current.split(":").map(Number);
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        return Math.abs(currentWidth / currentHeight - width / height) < Math.abs(bestWidth / bestHeight - width / height) ? current : best;
    });
}

// 上游对参考图有未公开的字节数上限（实测 2.5MB 拒、全尺寸 137KB 过），超限时逐级压到限内。
const VIDEO_IMAGE_MAX_BYTES = 512 * 1024;
const VIDEO_IMAGE_STEPS: Array<{ side: number; quality: number }> = [
    { side: 2048, quality: 85 }, { side: 1536, quality: 80 }, { side: 1024, quality: 75 }, { side: 768, quality: 70 },
];

async function normalizeVideoImage(dataUrl: string): Promise<string> {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
    if (!match) return dataUrl;
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length <= VIDEO_IMAGE_MAX_BYTES) return dataUrl;
    try {
        const source = sharp(bytes).rotate();
        let smallest = "";
        for (const { side, quality } of VIDEO_IMAGE_STEPS) {
            const buffer = await source.clone().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
            smallest = `data:image/jpeg;base64,${buffer.toString("base64")}`;
            if (buffer.length <= VIDEO_IMAGE_MAX_BYTES) break;
        }
        return smallest;
    } catch {
        // 压缩失败（如损坏图片）时回退原图，让上游返回真实错误而不是本地 500。
        return dataUrl;
    }
}

// Target is built solely from the validated catalog and fixed API paths. Redirects are not followed.
function requestUpstream(target: URL, apiKey: string, body?: Buffer, contentType?: string): Promise<UpstreamResponse> {
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const client = request({
            protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`,
            method: body ? "POST" : "GET",
            headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { "Content-Type": contentType!, "Content-Length": body.length } : {}) },
        }, (incoming: IncomingMessage) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
            incoming.on("end", () => resolve({ status: incoming.statusCode || 502, contentType: incoming.headers["content-type"] || "", body: Buffer.concat(chunks) }));
            incoming.on("error", reject);
            incoming.on("aborted", () => reject(new Error("Upstream response aborted")));
        });
        client.on("error", reject);
        client.end(body);
    });
}
