import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { APICallError } from "ai";
import { z } from "zod";
import { requireUser } from "./identity/auth-middleware.js";
import { accountModels, resolveModel, type Catalog } from "./catalog/catalog.js";
import { readUserApiKey } from "./credentials.js";
import { generationInput } from "./ai/input.js";
import { createImages, createSpeech, createText, createTextStream, createVideo, readVideo } from "./ai/generation.js";
import { downloadGatewayVideo } from "./ai/gateway-video.js";
import { logError, redactText } from "./log.js";

type GenerationOptions = { catalog: Catalog; encryptionKey?: string };
const taskIdSchema = z.string().uuid();

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
            const id = randomUUID();
            await database.query(
                "INSERT INTO user_generation_tasks (id, user_id, operation, base_url, model_id) VALUES ($1, $2, $3, $4, $5)",
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
    return router;
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
        if (!content) return response.json({ id: parsed.data, status: state.status === "error" ? "failed" : state.status, ...(state.status === "error" ? { error: { message: state.error } } : {}) });
        if (state.status !== "completed") return response.status(409).json({ error: { code: "VIDEO_NOT_READY", message: state.status === "error" ? state.error : "视频尚未生成完成" } });
        const video = state.videos[0];
        if (!video || video.type !== "url") throw new Error("上游没有返回视频下载地址");
        return response.type("video/mp4").send(await downloadGatewayVideo(video.url, row.base_url, apiKey, signal));
    } catch (error) {
        if (!signal.aborted) return generationFailure(response, error, apiKey);
    }
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
    const message = unauthorized ? "上游认证失败，请检查账号 API Key" : (error instanceof Error ? error.message : "上游生成失败，请检查模型和参数").replaceAll(apiKey, "[已隐藏]").slice(0, 300);
    const payload = { error: { code: unauthorized ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_ERROR", message } };
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
