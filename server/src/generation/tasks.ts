import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../identity/auth-middleware.js";
import { accountModels, resolveModel, type CatalogModel } from "../catalog/catalog.js";
import { readUserCredential } from "../credentials.js";
import { generationInput, type ImageInput } from "../ai/input.js";
import { createImages, readVideo } from "../ai/generation.js";
import { gateway } from "../gateway/index.js";
import { logError } from "../log.js";
import { storeAccountMedia, storeAccountMediaStream } from "../media.js";
import { apiKeyRequired, generationErrorMessage, generationFailure, referenceReader, requestSignal, type GenerationOptions, type ImageTaskContext, upstreamLogDetails } from "./shared.js";

const taskIdSchema = z.string().uuid();
const imageTaskResult = z.object({ images: z.array(z.object({ id: z.string(), mimeType: z.string(), bytes: z.number(), width: z.number(), height: z.number() })) });
const videoResult = z.object({ mediaId: z.string(), mimeType: z.string(), bytes: z.number() });
const IMAGE_TASK_TIMEOUT_MS = 15 * 60_000;
const IMAGE_TASK_STALE_MS = 20 * 60_000;
const imageTasks = new Set<string>();
const videoTaskStores = new Map<string, Promise<z.infer<typeof videoResult>>>();

export function createGenerationTaskRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    router.post("/generation-tasks", requireUser(database), async (request, response) => {
        const parsed = generationInput.safeParse(request.body);
        if (!parsed.success || parsed.data.capability !== "image") return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        if (!options.media) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
        const credential = await readUserCredential(database, response.locals.user.id, options.encryptionKey);
        if (!credential) return apiKeyRequired(response);
        const { apiKey } = credential;
        try {
            const models = await accountModels(options.catalog, apiKey, credential.baseUrl);
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
            const result = imageTaskResult.safeParse(row.result);
            if (result.success) return response.json({ id: parsed.data, status: "completed", images: result.data.images });
        }
        if (row.status === "failed") return response.json({ id: parsed.data, status: "failed", error: row.error || "上游生成失败" });
        if (row.status === "running" && Date.now() - new Date(row.created_at).getTime() > IMAGE_TASK_STALE_MS) {
            const message = "服务重启导致生成中断，请重新生成";
            await database.query("UPDATE user_generation_tasks SET status = 'failed', error = $2 WHERE id = $1 AND user_id = $3", [parsed.data, message, response.locals.user.id]);
            return response.json({ id: parsed.data, status: "failed", error: message });
        }
        return response.json({ id: parsed.data, status: "running" });
    });
    router.get("/generations/:id", requireUser(database), (request, response) => readVideoTask(request, response, database, options));
    return router;
}

async function runImageTask(context: ImageTaskContext) {
    if (imageTasks.has(context.id)) return;
    imageTasks.add(context.id);
    try {
        const result = await createImages(context.model, context.apiKey, context.input, AbortSignal.timeout(IMAGE_TASK_TIMEOUT_MS), referenceReader(context.database, context.options, context.userId));
        const images = [];
        for (const image of result.data) {
            const stored = await storeAccountMedia(context.database, context.options.media!, context.userId, Buffer.from(image.b64_json, "base64"), image.mime_type);
            const { width, height } = "width" in stored ? stored : { width: 0, height: 0 };
            images.push({ id: stored.id, mimeType: stored.mimeType, bytes: stored.bytes, width, height });
        }
        await context.database.query("UPDATE user_generation_tasks SET status = 'completed', result = $2 WHERE id = $1 AND user_id = $3", [context.id, JSON.stringify({ images }), context.userId]);
    } catch (error) {
        const message = generationErrorMessage(error);
        logError("image-task", error, { taskId: context.id, upstream: upstreamLogDetails(error, context.apiKey) });
        await context.database.query("UPDATE user_generation_tasks SET status = 'failed', error = $2 WHERE id = $1 AND user_id = $3", [context.id, message, context.userId]).catch(() => undefined);
    } finally {
        imageTasks.delete(context.id);
    }
}

async function readVideoTask(request: Request, response: Response, database: Pool, options: GenerationOptions) {
    const parsed = taskIdSchema.safeParse(request.params.id);
    if (!parsed.success) return taskNotFound(response);
    const task = await database.query<{ operation: unknown; base_url: string; result: unknown }>(
        "SELECT operation, base_url, result FROM user_generation_tasks WHERE id = $1 AND user_id = $2", [parsed.data, response.locals.user.id],
    );
    const row = task.rows[0];
    if (!row) return taskNotFound(response);
    const credential = await readUserCredential(database, response.locals.user.id, options.encryptionKey);
    if (!credential) return apiKeyRequired(response);
    const { apiKey } = credential;
    const signal = requestSignal(response);
    try {
        const operation = gateway.parseVideoOperation(row.operation);
        const state = await readVideo(row.operation, apiKey, signal);
        if (state.status === "error") return response.json({ id: parsed.data, status: "failed", error: { message: generationErrorMessage(state.error) } });
        if (state.status !== "completed") return response.json({ id: parsed.data, status: state.status });
        const saved = videoResult.safeParse(row.result);
        if (saved.success) return response.json({ id: parsed.data, status: "completed", ...saved.data });
        const video = state.videos[0];
        if (!video || video.type !== "url") throw new Error("上游没有返回视频下载地址");
        const stored = await storeVideoOnce(parsed.data, response.locals.user.id, database, options, () => operation.download(video.url, operation.binding, apiKey, signal));
        return response.json({ id: parsed.data, status: "completed", ...stored });
    } catch (error) {
        if (!signal.aborted) return generationFailure(response, error, apiKey);
    }
}

async function storeVideoOnce(taskId: string, userId: string, database: Pool, options: GenerationOptions, download: () => Promise<Readable>) {
    const existing = videoTaskStores.get(taskId);
    if (existing) return existing;
    const job = (async () => {
        if (!options.media) throw new Error("媒体存储尚未配置");
        const stored = await storeAccountMediaStream(database, options.media, userId, await download(), "video/mp4");
        const result = { mediaId: stored.id, mimeType: stored.mimeType, bytes: stored.bytes };
        await database.query("UPDATE user_generation_tasks SET result = $2 WHERE id = $1 AND user_id = $3", [taskId, JSON.stringify(result), userId]);
        return result;
    })();
    videoTaskStores.set(taskId, job);
    try {
        return await job;
    } finally {
        if (videoTaskStores.get(taskId) === job) videoTaskStores.delete(taskId);
    }
}

function taskNotFound(response: Response) {
    return response.status(404).json({ error: { code: "GENERATION_NOT_FOUND", message: "生成任务不存在" } });
}
