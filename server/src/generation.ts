import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";
import { logError } from "./log.js";
import { decryptCredential } from "./credential-crypto.js";
import { resolveModel, type Catalog } from "./catalog/catalog.js";

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
const inputSchema = z.discriminatedUnion("capability", [
    z.strictObject({ capability: z.literal("image"), modelId: z.string().min(1), input: imageInput }),
    z.strictObject({ capability: z.literal("video"), modelId: z.string().min(1), input: videoInput }),
]);
const taskIdSchema = z.string().uuid();
const taskResponseSchema = z.object({ id: z.string().min(1), status: z.string().optional() });
type GenerationOptions = { catalog: Catalog; encryptionKey?: string };
type UpstreamResponse = { status: number; contentType: string; body: Buffer };

export function createGenerationRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    // Restrict authentication middleware to these routes, not every subsequent API router.
    router.post("/generations", requireUser(database), async (request, response) => {
        if (!options.encryptionKey) return unavailable(response);
        const parsed = inputSchema.safeParse(request.body);
        if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        const model = resolveModel(options.catalog, parsed.data.modelId, parsed.data.capability);
        if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
        const apiKey = await currentKey(database, response.locals.user.id, options.encryptionKey);
        if (!apiKey) return keyRequired(response);
        const input = parsed.data.input;
        const isVideo = parsed.data.capability === "video";
        const isEdit = !isVideo && Boolean(input.images?.length);
        const path = isVideo ? "videos" : isEdit ? "images/edits" : "images/generations";
        const baseUrl = options.catalog.baseUrl;
        const url = upstreamTarget(baseUrl, path);
        if (!url) return unavailable(response);
        let body: Buffer;
        let contentType: string;
        if (isVideo || isEdit) {
            const form = new FormData();
            form.set("model", model.upstreamModel);
            for (const [key, value] of Object.entries(input)) {
                if (value !== undefined && !Array.isArray(value)) form.set(key, String(value));
            }
            if (isVideo) {
                const video = parsed.data.input as z.infer<typeof videoInput>;
                if (video.mode === "frames") {
                    if (video.images?.[0]) appendMedia(form, "first_frame", video.images[0]);
                    if (video.images?.[1]) appendMedia(form, "last_frame", video.images[1]);
                } else for (const image of video.images || []) appendMedia(form, "image[]", image);
                for (const reference of video.videos || []) appendMedia(form, "video[]", reference);
                for (const reference of video.audios || []) appendMedia(form, "audio[]", reference);
            } else {
                const images = input.images || [];
                for (const image of images) appendMedia(form, images.length === 1 ? "image" : "image[]", image);
            }
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
        if (upstream.status < 200 || upstream.status >= 300) return upstreamFailure(response, upstream.status);
        if (isVideo) {
            const task = parseTaskResponse(upstream.body);
            if (!task) return upstreamFailure(response, 502);
            const id = randomUUID();
            await database.query(
                "INSERT INTO user_generation_tasks (id, user_id, upstream_id, base_url, model_id) VALUES ($1, $2, $3, $4, $5)",
                [id, response.locals.user.id, task.id, baseUrl, model.id],
            );
            return response.status(201).json({ id, status: task.status || "queued" });
        }
        return response.status(200).type("application/json").send(upstream.body);
    });
    router.get("/generations/:id", requireUser(database), (request, response) => readTask(request, response, database, options, false));
    router.get("/generations/:id/content", requireUser(database), (request, response) => readTask(request, response, database, options, true));
    return router;
}

async function readTask(request: Request, response: Response, database: Pool, options: GenerationOptions, content: boolean) {
    if (!options.encryptionKey) return unavailable(response);
    const parsed = taskIdSchema.safeParse(request.params.id);
    if (!parsed.success) return taskNotFound(response);
    const task = await database.query<{ upstream_id: string; base_url: string }>(
        "SELECT upstream_id, base_url FROM user_generation_tasks WHERE id = $1 AND user_id = $2", [parsed.data, response.locals.user.id],
    );
    const row = task.rows[0];
    if (!row) return taskNotFound(response);
    const apiKey = await currentKey(database, response.locals.user.id, options.encryptionKey);
    if (!apiKey) return keyRequired(response);
    // Only the configured upstream can receive a key; reject tasks from a removed provider.
    if (row.base_url !== options.catalog.baseUrl) return unavailable(response);
    const path = `videos/${encodeURIComponent(row.upstream_id)}${content ? "/content" : ""}`;
    const target = upstreamTarget(row.base_url, path);
    if (!target) return unavailable(response);
    const upstream = await requestUpstream(target, apiKey);
    if (upstream.status < 200 || upstream.status >= 300) return upstreamFailure(response, upstream.status);
    return response.status(200).type(content ? "video/mp4" : "application/json").send(upstream.body);
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
        const parsed = taskResponseSchema.safeParse(payload.data || payload);
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

async function currentKey(database: Pool, userId: string, secret: string) {
    const credential = await database.query<{ encrypted_api_key: Buffer }>("SELECT encrypted_api_key FROM user_credentials WHERE user_id = $1", [userId]);
    if (!credential.rows[0]) return null;
    try {
        return decryptCredential(credential.rows[0].encrypted_api_key, secret);
    } catch (error) {
        logError("credentials", error);
        return null;
    }
}

function unavailable(response: Response) { return response.status(503).json({ error: { code: "GENERATION_NOT_CONFIGURED", message: "生成服务尚未配置" } }); }
function keyRequired(response: Response) { return response.status(422).json({ error: { code: "API_KEY_REQUIRED", message: "请先配置 API Key" } }); }
function taskNotFound(response: Response) { return response.status(404).json({ error: { code: "GENERATION_NOT_FOUND", message: "生成任务不存在" } }); }
function upstreamFailure(response: Response, status: number) {
    const unauthorized = status === 401 || status === 403;
    return response.status(502).json({ error: { code: unauthorized ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_ERROR", message: unauthorized ? "上游认证失败，请检查账号 API Key" : "上游生成失败，请检查模型和参数" } });
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
