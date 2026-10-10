import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Router, type Request, type Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";
import { decryptCredential } from "./credentials.js";
import type { Catalog } from "./catalog/catalog.js";
import { resolveModel, type AdapterId } from "./catalog/catalog.js";

const requestSchema = z.object({ capability: z.enum(["text", "image", "audio", "video"]), modelId: z.string().min(1), input: z.record(z.string(), z.unknown()) }).strict();

type GenerationOptions = { catalog: Catalog; encryptionKey?: string };

export function createGenerationRouter(database: Pool, options: GenerationOptions) {
    const router = Router();
    router.use(requireUser(database));
    router.post("/generations", (request, response) => generate(request, response, database, options));
    return router;
}

async function generate(request: Request, response: Response, database: Pool, options: GenerationOptions) {
    if (!options.encryptionKey) return response.status(503).json({ error: { code: "GENERATION_NOT_CONFIGURED", message: "生成服务尚未配置" } });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "生成参数无效" } });
    const model = resolveModel(options.catalog, parsed.data.modelId, parsed.data.capability);
    if (!model) return response.status(404).json({ error: { code: "MODEL_NOT_FOUND", message: "模型不可用" } });
    const credential = await database.query<{ encrypted_api_key: Buffer }>("SELECT encrypted_api_key FROM user_credentials WHERE user_id = $1", [response.locals.user.id]);
    const encrypted = credential.rows[0]?.encrypted_api_key;
    if (!encrypted) return response.status(422).json({ error: { code: "API_KEY_REQUIRED", message: "请先配置 API Key" } });
    const apiKey = decryptCredential(encrypted, options.encryptionKey);
    const target = trustedUpstreamUrl(options.catalog, model.adapter);
    if (!target) return response.status(503).json({ error: { code: "GENERATION_NOT_CONFIGURED", message: "生成服务尚未配置" } });
    const payload = JSON.stringify({ ...parsed.data.input, model: model.upstreamModel });
    const upstream = await requestTrustedUpstream(target, apiKey, payload);
    response.status(upstream.status).type(upstream.contentType || "application/json").send(upstream.body);
}

function trustedUpstreamUrl(catalog: Catalog, adapter: AdapterId) {
    try {
        const base = new URL(catalog.baseUrl);
        const path = pathFor(adapter);
        const url = new URL(path, `${base.origin}${base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`}`);
        return url.origin === base.origin && url.protocol === base.protocol ? url : null;
    } catch {
        return null;
    }
}

function pathFor(adapter: AdapterId) {
    const paths: Record<AdapterId, string> = { "openai-chat": "chat/completions", "openai-images": "images/generations", "openai-speech": "audio/speech", "openai-videos": "videos" };
    return paths[adapter];
}

type UpstreamResponse = { status: number; contentType?: string; body: string };

function requestTrustedUpstream(target: URL, apiKey: string, payload: string): Promise<UpstreamResponse> {
    const request = target.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const clientRequest = request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || undefined,
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
            },
            (incoming: IncomingMessage) => {
                const chunks: Buffer[] = [];
                incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
                incoming.on("end", () => resolve({ status: incoming.statusCode || 502, contentType: incoming.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }));
                incoming.on("error", reject);
            },
        );
        clientRequest.on("error", reject);
        clientRequest.end(payload);
    });
}
