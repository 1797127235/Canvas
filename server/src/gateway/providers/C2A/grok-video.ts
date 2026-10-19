import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { z } from "zod";
import type { ModelBinding, VideoCapability } from "../../contracts.js";
import { gatewayFetch, gatewayJson } from "../../transport.js";

const grokModels = new Set(["grok-imagine-video", "grok-imagine-video-1.5", "grok-imagine-video-1.5-preview"]);
const operationSchema = z.strictObject({ requestId: z.string().min(1) });
const startSchema = z.object({ request_id: z.string().min(1) });
// 上游完成态给的是相对路径（如 /v1/videos/<id>/content），不能按绝对 URL 校验；下载地址一律由本端拼出。
const statusSchema = z.object({
    status: z.string(),
    error: z.union([z.string(), z.object({ code: z.string().optional(), message: z.string().optional() })]).optional(),
    message: z.string().optional(),
});

function failureMessage(state: z.infer<typeof statusSchema>) {
    if (state.message) return state.message;
    if (typeof state.error === "string") return state.error;
    return state.error?.message || "Grok 视频生成失败";
}

function videoUrl(binding: ModelBinding, requestId: string, content = false, shared = false) {
    return `${binding.baseUrl.replace(/\/+$/, "")}/videos/${shared ? "" : "generations/"}${encodeURIComponent(requestId)}${content ? "/content" : ""}`;
}

export function createVideoModel(binding: ModelBinding, apiKey: string): Experimental_VideoModelV4 {
    if (!grokModels.has(binding.upstreamModel)) throw new Error(`C2A 视频协议暂未适配模型：${binding.upstreamModel}`);
    return {
        specificationVersion: "v4",
        provider: "C2A",
        modelId: binding.upstreamModel,
        maxVideosPerCall: 1,
        async doStart(options) {
            if (options.n !== 1) throw new Error("Grok 视频接口一次只支持生成一个视频");
            if (options.inputReferences?.some(file => !file.mediaType?.startsWith("image/"))) throw new Error("当前 Grok 视频接口适配只支持图片参考");
            // Grok 只有首帧和参考图，没有尾帧字段；两张图当参考图提交才不会把尾帧悄悄变成参考图。
            if ((options.frameImages?.length || 0) > 1) throw new Error("Grok 视频接口不支持首尾帧，请改用参考图模式");
            const imageFiles = [
                ...(options.image ? [options.image] : []),
                ...(options.frameImages || []).map(frame => frame.image),
                ...(options.inputReferences || []),
            ];
            const providerOptions = options.providerOptions.C2A as { resolution?: unknown; imageUrls?: unknown } | undefined;
            const signedImageUrls = Array.isArray(providerOptions?.imageUrls) ? providerOptions.imageUrls.filter((url): url is string => typeof url === "string") : [];
            if (imageFiles.length && signedImageUrls.length !== imageFiles.length) throw new Error("Grok 视频参考图缺少可访问的签名 URL");
            const imageUrls = signedImageUrls.map(url => ({ url }));
            const resolution = typeof providerOptions?.resolution === "string"
                ? providerOptions.resolution
                : options.resolution?.endsWith("x720") ? "720p" : options.resolution?.endsWith("x1080") ? "1080p" : options.resolution?.endsWith("x480") ? "480p" : undefined;
            const body = {
                model: binding.upstreamModel,
                prompt: options.prompt,
                ...(options.duration === undefined ? {} : { duration: options.duration }),
                ...(resolution ? { resolution } : {}),
                ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
                ...(imageUrls.length ? { image: imageUrls[0] } : {}),
                ...(imageUrls.length > 1 ? { reference_images: imageUrls.slice(1) } : {}),
            };
            const result = await gatewayJson(`${binding.baseUrl.replace(/\/+$/, "")}/videos/generations`, apiKey, body, options.abortSignal);
            return {
                operation: { requestId: startSchema.parse(result.value).request_id },
                warnings: [],
                response: { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) },
            };
        },
        async doStatus({ operation, abortSignal }) {
            const { requestId } = operationSchema.parse(operation);
            let result;
            let sharedStatusEndpoint = false;
            try {
                result = await gatewayJson(videoUrl(binding, requestId), apiKey, undefined, abortSignal);
            } catch (error) {
                if (!APICallError.isInstance(error) || error.statusCode !== 404) throw error;
                result = await gatewayJson(videoUrl(binding, requestId, false, true), apiKey, undefined, abortSignal);
                sharedStatusEndpoint = true;
            }
            const state = statusSchema.parse(result.value);
            const response = { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) };
            if (["pending", "queued", "running", "processing"].includes(state.status)) return { status: "pending", response };
            if (["failed", "error", "expired"].includes(state.status)) return { status: "error", error: failureMessage(state), response };
            if (["done", "completed", "succeeded"].includes(state.status)) {
                return { status: "completed", videos: [{ type: "url", url: videoUrl(binding, requestId, true, sharedStatusEndpoint), mediaType: "video/mp4" }], warnings: [], response };
            }
            return { status: "error", error: `无法识别的 Grok 视频任务状态：${state.status}`, response };
        },
    };
}

export const operationSchemaForC2A = operationSchema;

export async function downloadVideo(url: string, binding: ModelBinding, apiKey: string, signal: AbortSignal) {
    let target: URL;
    let base: URL;
    try {
        target = new URL(url);
        base = new URL(binding.baseUrl);
    } catch {
        throw new Error("Grok 视频下载地址无效");
    }
    if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/videos/`)) {
        throw new Error("Grok 视频下载地址不在已配置的网关内");
    }
    const response = await gatewayFetch(target, { headers: { Authorization: `Bearer ${apiKey}` }, signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Grok 视频下载失败（HTTP ${response.status}）`);
    const { Readable } = await import("node:stream");
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export const c2aVideoCapability = {
    model: createVideoModel,
    operationSchema,
    download: downloadVideo,
    aspectRatios: ["1:1", "16:9", "9:16"],
    options: ({ resolution, imageUrls }) => ({ C2A: {
        ...(resolution ? { resolution: resolution === "1920x1080" ? "1080p" : resolution === "1280x720" ? "720p" : resolution } : {}),
        ...(imageUrls ? { imageUrls } : {}),
    } }),
    validateInput: ({ videos, audios, frameCount, unsupportedReferences }) => {
        if (videos?.length || audios?.length || unsupportedReferences?.length) {
            throw new Error("当前 Grok 视频接口适配仅支持文生视频和图片参考生成，不支持参考视频/音频");
        }
        if ((frameCount || 0) > 1) throw new Error("Grok 视频接口不支持首尾帧，请改用参考图模式");
    },
} satisfies VideoCapability;
