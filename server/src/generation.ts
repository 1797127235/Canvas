import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { APICallError } from "ai";
import { z } from "zod";
import { requireUser } from "./identity/auth-middleware.js";
import { accountModels, resolveModel, type Catalog, type CatalogModel } from "./catalog/catalog.js";
import { readUserApiKey } from "./credentials.js";
import { generationInput } from "./ai/input.js";
import { createImages, createSpeech, createText, createTextStream, createVideo, readVideo } from "./ai/generation.js";
import { type ImageInput } from "./ai/input.js";
import { downloadGatewayVideo } from "./ai/gateway-video.js";
import { logError, redactText } from "./log.js";
import { storeAccountMedia, type MediaOptions } from "./media.js";

type GenerationOptions = { catalog: Catalog; encryptionKey?: string; media?: MediaOptions };
const taskIdSchema = z.string().uuid();
const IMAGE_TASK_TIMEOUT_MS = 15 * 60_000;
const IMAGE_TASK_STALE_MS = 20 * 60_000;

export function createGenerationRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    router.post("/generations", requireUser(database), async (request, response) => {
        const parsed = generationInput.safeParse(request.body);
        if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        const apiKey = await readUserApiKey(database, response.locals.user.id, options.encryptionKey);
        if (!apiKey) return apiKeyRequired(response);
        const signal = requestSignal(response);
        try {
            const models = await accountModels(options.catalog, apiKey);
            const model = resolveModel({ models }, parsed.data.modelId, parsed.data.capability);
            if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
            const generation = parsed.data;
            if (generation.capability === "image") return response.json(await createImages(model, apiKey, generation.input, signal));
            if (generation.capability === "audio") {
                const audio = await createSpeech(model, apiKey, generation.input, signal);
                return response.type(audio.mediaType).send(Buffer.from(audio.uint8Array));
            }
            if (generation.capability === "text") {
                if (!generation.input.stream) return response.json(await createText(model, apiKey, generation.input, signal));
                const result = createTextStream(model, apiKey, generation.input, signal);
                for await (const part of result.fullStream) {
                    if (part.type === "error") throw part.error;
                    if (part.type !== "text-delta") continue;
                    if (!response.headersSent) response.type("text/event-stream").set("Cache-Control", "no-store");
                    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part.text } }] })}\n\n`);
                }
                if (!response.headersSent) response.type("text/event-stream");
                response.end("data: [DONE]\n\n");
                return;
            }
            const result = await createVideo(model, apiKey, generation.input, signal);
            // 任务号由前端预生成，节点在建任务的几秒里就已持有它，刷新后可直接恢复。
            const id = generation.taskId ?? randomUUID();
            await database.query(
                "INSERT INTO user_generation_tasks (id, user_id, operation, base_url, model_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
                [id, response.locals.user.id, JSON.stringify(result.operation), model.baseUrl, model.id],
            );
            return response.status(201).json({ id, status: "pending", warnings: result.warnings });
        } catch (error) {
            if (!signal.aborted) return generationFailure(response, error, apiKey);
        }
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
    // 图片异步任务：创建后立即返回，服务端后台执行并把结果落进账号媒体，刷新页面后仍可按任务号恢复。
    router.post("/generation-tasks", requireUser(database), async (request, response) => {
        const parsed = generationInput.safeParse(request.body);
        if (!parsed.success || parsed.data.capability !== "image") return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        if (!options.media) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
        const apiKey = await readUserApiKey(database, response.locals.user.id, options.encryptionKey);
        if (!apiKey) return apiKeyRequired(response);
        try {
            const models = await accountModels(options.catalog, apiKey);
            const model = resolveModel({ models }, parsed.data.modelId, "image");
            if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
            const id = parsed.data.taskId ?? randomUUID();
            await database.query(
                "INSERT INTO user_generation_tasks (id, user_id, base_url, model_id, kind, status, operation) VALUES ($1, $2, $3, $4, 'image', 'running', $5) ON CONFLICT (id) DO NOTHING",
                [id, response.locals.user.id, model.baseUrl, model.id, JSON.stringify(parsed.data.input)],
            );
            void runImageTask({ database, options, id, userId: response.locals.user.id, model, apiKey, input: parsed.data.input });
            return response.status(201).json({ id, status: "running" });
        } catch (error) {
            return generationFailure(response, error, apiKey);
        }
    });
    router.get("/generation-tasks/:id", requireUser(database), async (request, response) => {
        const parsed = taskIdSchema.safeParse(request.params.id);
        if (!parsed.success) return taskNotFound(response);
        const task = await database.query<{ kind: string; status: string | null; result: unknown; error: string | null; created_at: Date }>(
            "SELECT kind, status, result, error, created_at FROM user_generation_tasks WHERE id = $1 AND user_id = $2", [parsed.data, response.locals.user.id],
        );
        const row = task.rows[0];
        if (!row || row.kind !== "image") return taskNotFound(response);
        if (row.status === "completed") {
            const result = z.object({ mediaIds: z.array(z.string()) }).safeParse(row.result);
            if (result.success) return response.json({ id: parsed.data, status: "completed", mediaIds: result.data.mediaIds });
        }
        if (row.status === "failed") return response.json({ id: parsed.data, status: "failed", error: row.error || "上游生成失败" });
        // 进程重启会丢失进行中的后台执行，超过单次生成上限即标记失败，避免客户端无限轮询。
        if (row.status === "running" && Date.now() - new Date(row.created_at).getTime() > IMAGE_TASK_STALE_MS) {
            const message = "服务重启导致生成中断，请重新生成";
            await database.query("UPDATE user_generation_tasks SET status = 'failed', error = $2 WHERE id = $1 AND user_id = $3", [parsed.data, message, response.locals.user.id]);
            return response.json({ id: parsed.data, status: "failed", error: message });
        }
        return response.json({ id: parsed.data, status: "running" });
    });
    return router;
}

const imageTasks = new Set<string>();
async function runImageTask(context: { database: Pool; options: GenerationOptions; id: string; userId: string; model: CatalogModel; apiKey: string; input: ImageInput }) {
    if (imageTasks.has(context.id)) return;
    imageTasks.add(context.id);
    try {
        const result = await createImages(context.model, context.apiKey, context.input, AbortSignal.timeout(IMAGE_TASK_TIMEOUT_MS));
        const mediaIds: string[] = [];
        for (const image of result.data) {
            const stored = await storeAccountMedia(context.database, context.options.media!, context.userId, Buffer.from(image.b64_json, "base64"), image.mime_type);
            mediaIds.push(stored.id);
        }
        // 任务号现在可由客户端提供，所有后台写入都限定在本人行，避免跨账号覆盖。
        await context.database.query("UPDATE user_generation_tasks SET status = 'completed', result = $2 WHERE id = $1 AND user_id = $3", [context.id, JSON.stringify({ mediaIds }), context.userId]);

    } catch (error) {
        const message = generationErrorMessage(error);
        logError("image-task", error, { taskId: context.id });
        await context.database.query("UPDATE user_generation_tasks SET status = 'failed', error = $2 WHERE id = $1 AND user_id = $3", [context.id, message, context.userId]).catch(() => undefined);
    } finally {
        imageTasks.delete(context.id);
    }
}

async function readTask(request: Request, response: Response, database: Pool, options: GenerationOptions, content: boolean) {
    const parsed = taskIdSchema.safeParse(request.params.id);
    if (!parsed.success) return taskNotFound(response);
    const task = await database.query<{ operation: unknown; base_url: string }>(
        "SELECT operation, base_url FROM user_generation_tasks WHERE id = $1 AND user_id = $2", [parsed.data, response.locals.user.id],
    );
    const row = task.rows[0];
    if (!row) return taskNotFound(response);
    const apiKey = await readUserApiKey(database, response.locals.user.id, options.encryptionKey);
    if (!apiKey) return apiKeyRequired(response);
    const signal = requestSignal(response);
    try {
        const state = await readVideo(row.operation, row.base_url, apiKey, signal);
        if (!content) return response.json({ id: parsed.data, status: state.status === "error" ? "failed" : state.status, ...(state.status === "error" ? { error: { message: generationErrorMessage(state.error) } } : {}) });
        if (state.status !== "completed") return response.status(409).json({ error: { code: "VIDEO_NOT_READY", message: state.status === "error" ? generationErrorMessage(state.error) : "视频尚未生成完成" } });
        const video = state.videos[0];
        if (!video || video.type !== "url") throw new Error("上游没有返回视频下载地址");
        return response.type("video/mp4").send(await downloadGatewayVideo(video.url, row.base_url, apiKey, signal));
    } catch (error) {
        if (!signal.aborted) return generationFailure(response, error, apiKey);
    }
}

// 上游错误原文是英文提示加请求号，数据库异常更是直接抛 SQL 文本，显示给用户没有意义。
// 这里统一换成可读提示；原始错误仍由 logError 连同上游响应体写进服务端日志，排查不受影响。
export function generationErrorMessage(error: unknown) {
    const raw = (typeof error === "string" ? error : error instanceof Error ? error.message : "").replace(/\s+/g, " ").trim();
    // 我们自己写的提示都是中文（例如「Grok 当前不支持参考视频生成」），原样保留。
    if (/[\u4e00-\u9fff]/.test(raw)) return raw.slice(0, 200);
    const status = APICallError.isInstance(error) ? error.statusCode || 0 : 0;
    if (status === 401 || status === 403) return "账号 API Key 无效或已过期，请重新保存后重试";
    if (status === 429) return "请求过于频繁，请稍后重试";
    if (/duration_seconds/i.test(raw)) return "该模型不支持所选视频时长，请调整时长后重试";
    if (status === 503 || /NO_ELIGIBLE_ACCOUNT|concurrency slot/i.test(raw)) return "上游服务繁忙，请稍后重试";
    if (/timeout/i.test(raw)) return "生成超时，请稍后重试";
    if (/unsupported_parameter|not support/i.test(raw)) return "该模型不支持所选参数，请调整参数后重试";
    return "生成失败，请稍后重试";
}

function requestSignal(response: Response) {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    return controller.signal;
}
function apiKeyRequired(response: Response) { return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } }); }
function taskNotFound(response: Response) { return response.status(404).json({ error: { code: "GENERATION_NOT_FOUND", message: "生成任务不存在" } }); }
function generationFailure(response: Response, error: unknown, apiKey: string) {
    const unauthorized = APICallError.isInstance(error) && [401, 403].includes(error.statusCode || 0);
    logError("generation", error, { upstream: upstreamLogDetails(error, apiKey) });
    const payload = { error: { code: unauthorized ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_ERROR", message: generationErrorMessage(error) } };
    if (response.headersSent) return response.end(`data: ${JSON.stringify(payload)}\n\n`);
    return response.status(502).json(payload);
}

// 把 AI SDK / 上游错误里的状态码、URL 和原始响应体记进日志，便于排查「Invalid JSON response」这类失败。
export function upstreamLogDetails(error: unknown, apiKey: string) {
    const source = error as { statusCode?: unknown; url?: unknown; responseBody?: unknown; text?: unknown; data?: unknown };
    const detail: Record<string, unknown> = {};
    if (typeof source.statusCode === "number") detail.status = source.statusCode;
    if (typeof source.url === "string") detail.url = source.url.replaceAll(apiKey, "[已隐藏]");
    for (const key of ["responseBody", "text", "data"] as const) {
        const value = source[key];
        if (value == null) continue;
        const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
        if (text) detail[key] = redactText(text.replaceAll(apiKey, "[已隐藏]"));
    }
    return Object.keys(detail).length ? detail : undefined;
}
