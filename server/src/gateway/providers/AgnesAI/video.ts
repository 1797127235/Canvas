import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import { z } from "zod";
import type { ModelBinding, VideoCapability } from "../../contracts.js";
import { gatewayJson } from "../../transport.js";
import { fetchResult } from "./media.js";

const operationSchema = z.strictObject({ videoId: z.string().min(1) });
const startSchema = z.object({ video_id: z.string().min(1) });
const statusSchema = z.object({ status: z.string(), url: z.string().url().nullable().optional(), metadata: z.object({ url: z.string().url().nullable().optional() }).nullable().optional(), error: z.unknown().optional() });
const aspectRatios = ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9"] as const;

type AgnesVideoOptions = { size?: string; imageUrls?: string[]; videoUrls?: string[]; audioUrls?: string[] };

function originUrl(binding: ModelBinding) {
    try {
        return new URL(binding.baseUrl).origin;
    } catch {
        throw new Error("Agnes 视频网关地址无效");
    }
}

function videoSize(size: string | undefined, resolution: string | undefined) {
    const value = `${resolution || size || ""}`.toLowerCase();
    if (value.includes("2k") || value.includes("2560x1440") || value.includes("1440x2560")) return "2K";
    if (value.includes("1080") || value.includes("1080p")) return "1080P";
    if (value.includes("1k") || value.includes("1024x1024")) return "1K";
    return "720P";
}

function videoContentUrl(binding: ModelBinding, videoId: string) {
    const url = new URL("/agnesapi", originUrl(binding));
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("model_name", binding.upstreamModel);
    return url.toString();
}

function mediaUrls(options: AgnesVideoOptions, mediaType: "image" | "video" | "audio") {
    const key = `${mediaType}Urls` as keyof AgnesVideoOptions;
    const value = options[key];
    return Array.isArray(value) ? value.filter((url): url is string => typeof url === "string" && url.length > 0) : [];
}

export function createVideoModel(binding: ModelBinding, apiKey: string): Experimental_VideoModelV4 {
    if (!binding.upstreamModel.startsWith("agnes-video-2.5")) throw new Error(`Agnes 视频协议暂未适配模型：${binding.upstreamModel}`);
    return {
        specificationVersion: "v4",
        provider: "AgnesAI",
        modelId: binding.upstreamModel,
        maxVideosPerCall: 1,
        async doStart(options) {
            if (options.n !== 1) throw new Error("Agnes 视频接口一次只支持生成一个视频");
            const providerOptions = (options.providerOptions.AgnesAI || {}) as AgnesVideoOptions;
            const images = mediaUrls(providerOptions, "image");
            const videos = mediaUrls(providerOptions, "video");
            const audios = mediaUrls(providerOptions, "audio");
            const frames = options.frameImages || [];
            const referenceFiles = options.inputReferences || [];
            const expectedImages = referenceFiles.filter(file => file.mediaType?.startsWith("image/")).length + frames.length;
            const expectedVideos = referenceFiles.filter(file => file.mediaType?.startsWith("video/")).length;
            const expectedAudios = referenceFiles.filter(file => file.mediaType?.startsWith("audio/")).length;
            if (expectedImages !== images.length || expectedVideos !== videos.length || expectedAudios !== audios.length) throw new Error("Agnes 视频参考素材缺少可访问的签名 URL");
            const requestedSize = videoSize(providerOptions.size, options.resolution);
            if (options.duration !== undefined && (!Number.isFinite(options.duration) || options.duration < 4 || options.duration > 12)) throw new Error("Agnes 视频时长必须在 4 到 12 秒之间");
            if (binding.upstreamModel === "agnes-video-2.5-flash" && requestedSize !== "720P") throw new Error("Agnes Video 2.5 Flash 仅支持 720P");
            if (images.length > 8 || audios.length > 3 || videos.length > 1) throw new Error("Agnes 视频参考素材数量超出限制");
            if (binding.upstreamModel === "agnes-video-2.5-flash" && (videos.length || images.length > 5)) throw new Error("Agnes Video 2.5 Flash 不支持参考视频且最多支持五张参考图");
            const body: Record<string, unknown> = {
                model: binding.upstreamModel,
                prompt: options.prompt || "",
                n: 1,
                size: requestedSize,
                ...(options.aspectRatio && options.aspectRatio !== "adaptive" ? { aspect_ratio: options.aspectRatio } : {}),
                ...(options.duration === undefined ? {} : { seconds: String(options.duration) }),
                ...(options.seed === undefined ? {} : { seed: options.seed }),
            };
            if (frames.length) {
                if (frames.length > 2) throw new Error("Agnes 首尾帧最多支持两张图片");
                body.mode = "keyframe";
                const frameUrls = images.slice(0, frames.length);
                const firstIndex = frames.findIndex(frame => frame.frameType === "first_frame");
                const lastIndex = frames.findIndex(frame => frame.frameType === "last_frame");
                if (firstIndex >= 0) body.first_frame = frameUrls[firstIndex];
                if (lastIndex >= 0) body.last_frame = frameUrls[lastIndex];
                if (!body.first_frame && !body.last_frame) throw new Error("Agnes 首尾帧缺少可访问的图片 URL");
            } else if (images.length || videos.length || audios.length) {
                body.mode = "reference";
                if (images.length) body.images = images;
                if (audios.length) body.audios = audios;
                if (videos.length) body.videos = videos.map(url => ({ url }));
            } else {
                body.mode = "text";
            }
            const result = await gatewayJson(`${binding.baseUrl.replace(/\/+$/, "")}/videos`, apiKey, body, options.abortSignal, options.headers);
            const { video_id: videoId } = startSchema.parse(result.value);
            return { operation: { videoId }, warnings: [], response: { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) } };
        },
        async doStatus({ operation, abortSignal, headers }) {
            const { videoId } = operationSchema.parse(operation);
            const result = await gatewayJson(videoContentUrl(binding, videoId), apiKey, undefined, abortSignal, headers);
            const state = statusSchema.parse(result.value);
            const response = { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) };
            if (["queued", "in_progress", "processing", "pending", "running"].includes(state.status)) return { status: "pending", response };
            const resultUrl = state.url || state.metadata?.url;
            if (state.status === "completed" && resultUrl) return { status: "completed", videos: [{ type: "url", url: resultUrl, mediaType: "video/mp4" }], warnings: [], response };
            if (["failed", "error", "expired"].includes(state.status)) return { status: "error", error: errorMessage(state.error), response };
            return { status: "error", error: `无法识别的 Agnes 视频任务状态：${state.status}`, response };
        },
    };
}

function errorMessage(value: unknown) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
    return "Agnes 视频生成失败";
}

export async function downloadVideo(url: string, binding: ModelBinding, _apiKey: string, signal: AbortSignal) {
    const response = await fetchResult(url, binding, signal);
    if (!response.body) throw new Error("Agnes 视频下载失败：响应为空");
    const { Readable } = await import("node:stream");
    return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export const operationSchemaForAgnesAI = operationSchema;

export const agnesVideoCapability = {
    model: createVideoModel,
    operationSchema,
    download: downloadVideo,
    aspectRatios,
    options: ({ resolution, size, imageUrls, videoUrls, audioUrls }: { resolution?: string; watermark?: boolean; size?: string; imageUrls?: string[]; videoUrls?: string[]; audioUrls?: string[] }) => ({ AgnesAI: {
        ...(resolution || size ? { size: resolution || size } : {}),
        ...(imageUrls ? { imageUrls } : {}),
        ...(videoUrls ? { videoUrls } : {}),
        ...(audioUrls ? { audioUrls } : {}),
    } }),
    validateInput: ({ videos, audios, unsupportedReferences }) => {
        if (videos?.length && videos.length > 1) throw new Error("Agnes 视频参考最多支持一段视频");
        if (audios && audios.length > 3) throw new Error("Agnes 音频参考最多支持三段音频");
        if (unsupportedReferences?.some(type => !type.startsWith("image/") && !type.startsWith("video/") && !type.startsWith("audio/"))) throw new Error("Agnes 视频参考素材类型不支持");
    },
} satisfies VideoCapability;
