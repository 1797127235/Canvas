import type { Response } from "express";
import type { Pool } from "pg";
import { APICallError } from "ai";
import type { ImageInput } from "../ai/input.js";
import { mediaReader } from "../ai/generation.js";
import type { Catalog, CatalogModel } from "../catalog/catalog.js";
import { logError, redactText } from "../log.js";
import { readAccountMediaBytes, type MediaOptions } from "../media.js";

export type GenerationOptions = { catalog: Catalog; encryptionKey?: string; media?: MediaOptions; appOrigin?: string; mediaLinkSecret?: string };

export function referenceReader(database: Pool, options: GenerationOptions, userId: string) {
    return mediaReader(async mediaId => {
        if (!options.media) throw new Error("媒体存储尚未配置");
        return readAccountMediaBytes(database, options.media, userId, mediaId);
    });
}

export function requestSignal(response: Response) {
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    return controller.signal;
}

export function apiKeyRequired(response: Response) {
    return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } });
}

export function generationFailure(response: Response, error: unknown, apiKey: string) {
    const unauthorized = APICallError.isInstance(error) && [401, 403].includes(error.statusCode || 0);
    logError("generation", error, { upstream: upstreamLogDetails(error, apiKey) });
    const payload = { error: { code: unauthorized ? "UPSTREAM_AUTH_FAILED" : "UPSTREAM_ERROR", message: generationErrorMessage(error) } };
    if (response.headersSent) return response.end(`data: ${JSON.stringify(payload)}\n\n`);
    return response.status(502).json(payload);
}

export function generationErrorMessage(error: unknown) {
    const raw = (typeof error === "string" ? error : error instanceof Error ? error.message : "").replace(/\s+/g, " ").trim();
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

export type ImageTaskContext = { database: Pool; options: GenerationOptions; id: string; userId: string; model: CatalogModel; apiKey: string; input: ImageInput };
