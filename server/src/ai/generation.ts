import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import {
    generateImage, generateSpeech, generateText, streamText,
    experimental_startVideo as startVideo, experimental_getVideoStatus as getVideoStatus,
    type ModelMessage,
} from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import sharp from "sharp";
import { z } from "zod";
import type { CatalogModel } from "../catalog/catalog.js";
import type { ImageInput, SpeechInput, TextInput, VideoInput } from "./input.js";
import { gatewayFetch, gatewayVideoModel } from "./gateway-video.js";

const operationSchema = z.strictObject({
    version: z.literal(1), adapter: z.enum(["xai-videos", "gateway-videos"]),
    modelId: z.string().min(1), operation: z.json(),
});
export type VideoOperation = Omit<z.infer<typeof operationSchema>, "operation"> & { operation: JSONValue };

function providers(model: CatalogModel, apiKey: string) {
    const options = { apiKey, baseURL: model.baseUrl, fetch: gatewayFetch };
    return { openai: createOpenAI(options), xai: createXai(options) };
}

export async function createImages(model: CatalogModel, apiKey: string, input: ImageInput, signal: AbortSignal) {
    const { openai, xai } = providers(model, apiKey);
    const isXai = model.adapter === "xai-images";
    const { quality, background, output_format } = input;
    try {
        const result = await generateImage({
            model: isXai ? xai.image(model.upstreamModel) : openai.image(model.upstreamModel),
            prompt: input.images?.length ? { text: input.prompt, images: input.images } : input.prompt,
            n: input.n, maxImagesPerCall: input.n || 1,
            ...(isXai ? { aspectRatio: mediaAspectRatio(input.size, ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9", "9:21"]) } : { size: input.size as `${number}x${number}` | undefined }),
            providerOptions: isXai ? { xai: { quality, output_format } } : { openai: { quality, background, outputFormat: output_format } },
            maxRetries: 0, abortSignal: signal,
        });
        return { data: result.images.map(image => ({ b64_json: image.base64, mime_type: image.mediaType })), warnings: result.warnings };
    } catch (error) {
        // 部分 OpenAI 兼容网关返回 url 形态结果，SDK 只认 b64_json；这里下载 url 归一化为 base64。
        const bridged = await bridgeImageUrls(error, signal);
        if (bridged) return bridged;
        throw error;
    }
}

async function bridgeImageUrls(error: unknown, signal: AbortSignal) {
    const responseBody = (error as { responseBody?: unknown }).responseBody;
    if (typeof responseBody !== "string") return null;
    let payload: { data?: Array<{ url?: unknown; b64_json?: unknown }> };
    try {
        payload = JSON.parse(responseBody);
    } catch {
        return null;
    }
    if (!Array.isArray(payload?.data) || !payload.data.length) return null;
    const images: Array<{ b64_json: string; mime_type: string }> = [];
    for (const entry of payload.data) {
        if (typeof entry?.b64_json === "string" && entry.b64_json) {
            images.push({ b64_json: entry.b64_json, mime_type: "image/png" });
            continue;
        }
        if (typeof entry?.url !== "string" || !entry.url) return null;
        const response = await fetch(entry.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
        if (!response.ok) throw new Error(`生成结果下载失败：HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = response.headers.get("content-type")?.split(";")[0];
        images.push({ b64_json: buffer.toString("base64"), mime_type: mimeType === "image/jpeg" || mimeType === "image/webp" ? mimeType : "image/png" });
    }
    if (!images.length) return null;
    return { data: images, warnings: [] };
}

export async function createSpeech(model: CatalogModel, apiKey: string, input: SpeechInput, signal: AbortSignal) {
    const { openai } = providers(model, apiKey);
    const result = await generateSpeech({
        model: openai.speech(model.upstreamModel), text: input.input, voice: input.voice,
        outputFormat: input.response_format, speed: input.speed, instructions: input.instructions,
        maxRetries: 0, abortSignal: signal,
    });
    return result.audio;
}

function messages(input: TextInput): ModelMessage[] {
    return input.messages.map(message => {
        if (typeof message.content === "string") return { role: message.role, content: message.content };
        if (message.role === "system") return { role: "system", content: message.content.filter(part => part.type === "text").map(part => part.text).join("\n") };
        if (message.role === "assistant") return { role: "assistant", content: message.content.map(part => part.type === "text" ? part : { type: "file" as const, data: part.image_url.url, mediaType: "image/png" }) };
        return { role: "user", content: message.content.map(part => part.type === "text" ? part : { type: "image" as const, image: part.image_url.url }) };
    });
}

function textOptions(model: CatalogModel, apiKey: string, input: TextInput, signal: AbortSignal) {
    return {
        model: providers(model, apiKey).openai.chat(model.upstreamModel), messages: messages(input),
        providerOptions: { openai: { reasoningEffort: input.reasoning_effort } }, maxRetries: 0, abortSignal: signal,
    };
}
export function createTextStream(model: CatalogModel, apiKey: string, input: TextInput, signal: AbortSignal) {
    return streamText(textOptions(model, apiKey, input, signal));
}
export async function createText(model: CatalogModel, apiKey: string, input: TextInput, signal: AbortSignal) {
    const result = await generateText(textOptions(model, apiKey, input, signal));
    return { choices: [{ message: { role: "assistant", content: result.text } }] };
}

function videoModel(adapter: VideoOperation["adapter"], modelId: string, baseUrl: string, apiKey: string) {
    return adapter === "xai-videos" ? createXai({ apiKey, baseURL: baseUrl, fetch: gatewayFetch }).video(modelId) : gatewayVideoModel(modelId, baseUrl, apiKey);
}

export async function createVideo(model: CatalogModel, apiKey: string, input: VideoInput, signal: AbortSignal) {
    const adapter = model.adapter === "xai-videos" ? "xai-videos" : "gateway-videos";
    const images = await normalizeVideoImages(input.images || []);
    const videos = input.videos || [], audios = input.audios || [];
    const frames = input.mode !== "reference" && images.length <= 2 && !videos.length && !audios.length;
    const inputReferences = frames ? undefined : [
        ...images.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
        ...videos.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
        ...audios.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
    ];
    const frameImages = frames && images.length ? images.map((image, index) => ({ image, frameType: index === 0 ? "first_frame" as const : "last_frame" as const })) : undefined;
    // xAI 当前 provider 支持图片 R2V，但不支持把视频作为 R2V 参考；H3 兼容端点负责 videos 参考输入。
    if (adapter === "xai-videos" && videos.length) throw new Error("Grok 当前不支持参考视频生成，请改用 MiniMax-H3；Grok 可使用图片参考或视频编辑接口");
    const result = await startVideo({
        model: videoModel(adapter, model.upstreamModel, model.baseUrl, apiKey), prompt: input.prompt,
        duration: input.seconds ? Number(input.seconds) : undefined,
        aspectRatio: mediaAspectRatio(input.size), frameImages, inputReferences,
        generateAudio: input.generate_audio,
        providerOptions: adapter === "xai-videos"
            ? { xai: { resolution: input.resolution_name, watermark: input.watermark } }
            : { gateway: { resolution: input.resolution_name, watermark: input.watermark } },
        maxRetries: 0, abortSignal: signal,
    });
    return { operation: { version: 1, adapter, modelId: model.upstreamModel, operation: result.operation } satisfies VideoOperation, warnings: result.warnings };
}

export async function readVideo(operation: unknown, baseUrl: string, apiKey: string, signal: AbortSignal) {
    const saved = operationSchema.parse(operation);
    return getVideoStatus(videoModel(saved.adapter, saved.modelId, baseUrl, apiKey), { operation: saved.operation as JSONValue, maxRetries: 0, abortSignal: signal });
}

export function mediaAspectRatio(size?: string, ratios: readonly `${number}:${number}`[] = ["1:1", "3:4", "4:3", "16:9", "9:16", "21:9"]): `${number}:${number}` | undefined {
    if (!size) return undefined;
    const [width, height] = size.split("x").map(Number);
    if (!width || !height) return undefined;
    return ratios.reduce((best, current) => {
        const [cw, ch] = current.split(":").map(Number), [bw, bh] = best.split(":").map(Number);
        return Math.abs(cw / ch - width / height) < Math.abs(bw / bh - width / height) ? current : best;
    });
}

// 单张沿用已确认的 512KB 上限；多张参考图还有总请求体积上限，实测三张合计超过约 975KB 会被上游拒绝。
const VIDEO_IMAGE_MAX_BYTES = 512 * 1024;
const VIDEO_IMAGES_TOTAL_BYTES = 700 * 1024;
const VIDEO_IMAGE_STEPS = [{ side: 2048, quality: 85 }, { side: 1536, quality: 80 }, { side: 1024, quality: 75 }, { side: 768, quality: 70 }, { side: 512, quality: 60 }];
function normalizeVideoImages(dataUrls: string[]) {
    const limit = Math.min(VIDEO_IMAGE_MAX_BYTES, Math.floor(VIDEO_IMAGES_TOTAL_BYTES / Math.max(1, dataUrls.length)));
    return Promise.all(dataUrls.map((dataUrl) => normalizeVideoImage(dataUrl, limit)));
}
async function normalizeVideoImage(dataUrl: string, limit: number) {
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    if (bytes.length <= limit) return dataUrl;
    const source = sharp(bytes).rotate();
    let smallest = dataUrl;
    for (const { side, quality } of VIDEO_IMAGE_STEPS) {
        const buffer = await source.clone().resize({ width: side, height: side, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
        smallest = `data:image/jpeg;base64,${buffer.toString("base64")}`;
        if (buffer.length <= limit) return smallest;
    }
    return smallest;
}
