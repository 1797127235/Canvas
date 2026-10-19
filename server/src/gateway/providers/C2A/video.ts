import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import type { ModelBinding, VideoCapability } from "../../contracts.js";
import { gatewayFetch, gatewayJson } from "../../transport.js";

const grokModels = new Set(["grok-imagine-video", "grok-imagine-video-1.5"]);
const operationSchema = z.strictObject({ requestId: z.string().min(1) });
const startSchema = z.object({ request_id: z.string().min(1) });
const statusSchema = z.object({ status: z.string(), video: z.object({ url: z.string().url() }).optional(), error: z.unknown().optional(), message: z.string().optional() });

function videoUrl(binding: ModelBinding, requestId: string, content = false) {
    return `${binding.baseUrl.replace(/\/+$/, "")}/videos/generations/${encodeURIComponent(requestId)}${content ? "/content" : ""}`;
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
            if (options.generateAudio) throw new Error("当前 Grok 视频接口适配不支持 generate_audio");
            if (options.inputReferences?.some(file => !file.mediaType?.startsWith("image/"))) throw new Error("当前 Grok 视频接口适配只支持图片参考");
            if (options.frameImages?.some(frame => frame.frameType !== "first_frame")) throw new Error("当前 Grok 视频接口适配只支持首帧图片");
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
                ...(imageUrls.length === 1 ? { image: imageUrls[0] } : imageUrls.length > 1 ? { reference_images: imageUrls } : {}),
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
            const url = videoUrl(binding, requestId);
            const result = await gatewayJson(url, apiKey, undefined, abortSignal);
            const state = statusSchema.parse(result.value);
            const response = { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) };
            if (["pending", "queued", "running", "processing"].includes(state.status)) return { status: "pending", response };
            if (["failed", "error", "expired"].includes(state.status)) return { status: "error", error: state.message || (typeof state.error === "string" ? state.error : "Grok 视频生成失败"), response };
            if (["done", "completed", "succeeded"].includes(state.status) && state.video?.url) {
                return { status: "completed", videos: [{ type: "url", url: videoUrl(binding, requestId, true), mediaType: "video/mp4" }], warnings: [], response };
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
    validateInput: ({ videos, audios, generateAudio, frameCount, unsupportedReferences }) => {
        if (videos?.length || audios?.length || generateAudio || (frameCount || 0) > 1 || unsupportedReferences?.length) {
            throw new Error("当前 Grok 视频接口适配仅支持文生视频和图片参考生成");
        }
    },
} satisfies VideoCapability;
