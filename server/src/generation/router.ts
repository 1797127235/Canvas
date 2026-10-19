import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { requireUser } from "../identity/auth-middleware.js";
import { accountModels, resolveModel } from "../catalog/catalog.js";
import { readUserCredential } from "../credentials.js";
import { generationInput } from "../ai/input.js";
import { createImages, createSpeech, createText, createTextStream, createVideo } from "../ai/generation.js";
import { signedMediaUrl, storeAccountMedia } from "../media.js";
import { apiKeyRequired, generationFailure, referenceReader, requestSignal, type GenerationOptions } from "./shared.js";
import { createGenerationTaskRouter } from "./tasks.js";

export function createGenerationRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    router.post("/generations", requireUser(database), async (request, response) => {
        const parsed = generationInput.safeParse(request.body);
        if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
        const credential = await readUserCredential(database, response.locals.user.id, options.encryptionKey);
        if (!credential) return apiKeyRequired(response);
        const { apiKey } = credential;
        const signal = requestSignal(response);
        try {
            const models = await accountModels(options.catalog, apiKey, credential.baseUrl);
            const model = resolveModel({ models }, parsed.data.modelId, parsed.data.capability);
            if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
            const generation = parsed.data;
            const media = referenceReader(database, options, response.locals.user.id);
            if (generation.capability === "image") return response.json(await createImages(model, apiKey, generation.input, signal, media));
            if (generation.capability === "audio") {
                if (!options.media) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
                const audio = await createSpeech(model, apiKey, generation.input, signal);
                const stored = await storeAccountMedia(database, options.media, response.locals.user.id, Buffer.from(audio.uint8Array), audio.mediaType);
                return response.json({ mediaId: stored.id, mimeType: stored.mimeType, bytes: stored.bytes });
            }
            if (generation.capability === "text") {
                if (!generation.input.stream) return response.json(await createText(model, apiKey, generation.input, signal, media));
                const result = await createTextStream(model, apiKey, generation.input, signal, media);
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
            const referenceRefs = [...(generation.input.images || []), ...(generation.input.videos || []), ...(generation.input.audios || [])];
            const referenceUrls = options.appOrigin && options.mediaLinkSecret
                ? Object.fromEntries(referenceRefs.map(ref => [ref, signedMediaUrl(options.appOrigin!, options.mediaLinkSecret!, ref.slice("remote:".length))]))
                : undefined;
            const result = await createVideo(model, apiKey, generation.input, signal, media, referenceUrls);
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
    router.use(createGenerationTaskRouter(database, options));
    return router;
}

function taskNotFound(response: import("express").Response) {
    return response.status(404).json({ error: { code: "GENERATION_NOT_FOUND", message: "生成任务不存在" } });
}
