import {
    generateImage, generateSpeech, generateText, streamText,
    experimental_startVideo as startVideo, experimental_getVideoStatus as getVideoStatus,
    type ModelMessage,
} from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import sharp from "sharp";
import { type ModelBinding } from "../gateway/contracts.js";
import { chatModel, imageCapability as imageCapabilityFor, imageModel, videoCapability as videoCapabilityFor, speechModel, videoModel as gatewayVideoModelForBinding, parseVideoOperation, textProviderOptions } from "../gateway/index.js";
import type { ImageInput, SpeechInput, TextInput, VideoInput } from "./input.js";
import { mediaRefId } from "./input.js";

export type VideoOperation = { version: 2; binding: ModelBinding; operation: JSONValue };

// 素材按能力做类型校验：身份字符串本身不带类型，用实际 mime 把关（等价于原先 data URL 正则的约束）。
const MEDIA_TYPES: Record<"image" | "video" | "audio", RegExp> = {
    image: /^image\/(png|jpeg|webp)$/,
    video: /^video\/(mp4|webm)$/,
    audio: /^audio\/(mpeg|mp3|wav|ogg|webm)$/,
};

// 生成流程按 remote:<uuid> 取素材字节的唯一入口。这里把字节转成 data URL 交给 SDK，
// 浏览器到 api 这一段只传身份（KB 级）；api 到上游这一段仍是 base64，那是上游协议本身的形状。
type MediaResolve = (ref: string) => Promise<string>;
export type MediaReader = { image: MediaResolve; video: MediaResolve; audio: MediaResolve };

export function mediaReader(read: (mediaId: string) => Promise<{ bytes: Buffer; mimeType: string }>): MediaReader {
    const resolve = (category: keyof typeof MEDIA_TYPES): MediaResolve => async (ref) => {
        const { bytes, mimeType } = await read(mediaRefId(ref));
        if (!MEDIA_TYPES[category].test(mimeType)) throw new Error("参考素材类型不支持");
        return `data:${mimeType};base64,${bytes.toString("base64")}`;
    };
    return { image: resolve("image"), video: resolve("video"), audio: resolve("audio") };
}

export async function createImages(model: ModelBinding, apiKey: string, input: ImageInput, signal: AbortSignal, media: MediaReader) {
    const images = input.images?.length ? await Promise.all(input.images.map(media.image)) : [];
    const imageCapability = imageCapabilityFor(model.providerId);
    const { quality, background, output_format } = input;
    try {
        const result = await generateImage({
            model: imageModel(model, apiKey),
            prompt: images.length ? { text: input.prompt, images } : input.prompt,
            n: input.n, maxImagesPerCall: imageCapability.maxImagesPerCall || 1,
            ...(imageCapability?.aspectRatios ? { aspectRatio: mediaAspectRatio(input.size, imageCapability.aspectRatios) } : { size: input.size as `${number}x${number}` | undefined }),
            providerOptions: imageCapability.options?.({ size: input.size, quality, background, outputFormat: output_format }) as never,
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

export async function createSpeech(model: ModelBinding, apiKey: string, input: SpeechInput, signal: AbortSignal) {
    const result = await generateSpeech({
        model: speechModel(model, apiKey), text: input.input, voice: input.voice,
        outputFormat: input.response_format, speed: input.speed, instructions: input.instructions,
        maxRetries: 0, abortSignal: signal,
    });
    return result.audio;
}

// 文本链路的图片引用也改传身份：url 为 remote:<uuid> 时按账号素材读取，其余（已是 data URL 或 http 地址）原样透传。
async function resolveImageUrl(url: string, media: MediaReader) {
    return url.startsWith("remote:") ? media.image(url) : url;
}

async function messages(input: TextInput, media: MediaReader): Promise<ModelMessage[]> {
    return Promise.all(input.messages.map(async (message): Promise<ModelMessage> => {
        if (typeof message.content === "string") return { role: message.role, content: message.content };
        if (message.role === "system") return { role: "system", content: message.content.filter(part => part.type === "text").map(part => part.text).join("\n") };
        const parts = await Promise.all(message.content.map(async (part) => (part.type === "text" ? part : { ...part, image_url: { url: await resolveImageUrl(part.image_url.url, media) } })));
        if (message.role === "assistant") return { role: "assistant", content: parts.map(part => part.type === "text" ? part : { type: "file" as const, data: part.image_url.url, mediaType: "image/png" }) };
        return { role: "user", content: parts.map(part => part.type === "text" ? part : { type: "image" as const, image: part.image_url.url }) };
    }));
}

async function textOptions(model: ModelBinding, apiKey: string, input: TextInput, signal: AbortSignal, media: MediaReader) {
    return {
        model: chatModel(model, apiKey), messages: await messages(input, media),
        providerOptions: textProviderOptions(model.providerId, { reasoningEffort: input.reasoning_effort }) as never, maxRetries: 0, abortSignal: signal,
    };
}
export async function createTextStream(model: ModelBinding, apiKey: string, input: TextInput, signal: AbortSignal, media: MediaReader) {
    return streamText(await textOptions(model, apiKey, input, signal, media));
}
export async function createText(model: ModelBinding, apiKey: string, input: TextInput, signal: AbortSignal, media: MediaReader) {
    const result = await generateText(await textOptions(model, apiKey, input, signal, media));
    return { choices: [{ message: { role: "assistant", content: result.text } }] };
}

export async function createVideo(model: ModelBinding, apiKey: string, input: VideoInput, signal: AbortSignal, media: MediaReader, referenceUrls?: Record<string, string>) {
    const videoCapability = videoCapabilityFor(model.providerId);
    const imageUrls = (input.images || []).map(ref => referenceUrls?.[ref]).filter((url): url is string => Boolean(url));
    const videoUrls = (input.videos || []).map(ref => referenceUrls?.[ref]).filter((url): url is string => Boolean(url));
    const audioUrls = (input.audios || []).map(ref => referenceUrls?.[ref]).filter((url): url is string => Boolean(url));
    const [images, videos, audios] = await Promise.all([
        normalizeVideoImages(await Promise.all((input.images || []).map(media.image))),
        Promise.all((input.videos || []).map(media.video)),
        Promise.all((input.audios || []).map(media.audio)),
    ]);
    const frames = input.mode !== "reference" && images.length <= 2 && !videos.length && !audios.length;
    const inputReferences = frames ? undefined : [
        ...images.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
        ...videos.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
        ...audios.map(data => ({ data, mediaType: data.slice(5, data.indexOf(";")) })),
    ];
    const frameImages = frames && images.length ? images.map((image, index) => ({ image, frameType: index === 0 ? "first_frame" as const : "last_frame" as const })) : undefined;
    videoCapability.validateInput?.({
        videos, audios, generateAudio: input.generate_audio,
        frameCount: frameImages?.length || 0,
        unsupportedReferences: inputReferences?.filter(file => !file.mediaType.startsWith("image/")).map(file => file.mediaType),
    });
    const result = await startVideo({
        model: gatewayVideoModelForBinding(model, apiKey), prompt: input.prompt,
        duration: input.seconds ? Number(input.seconds) : undefined,
        aspectRatio: mediaAspectRatio(input.size, videoCapability?.aspectRatios), frameImages, inputReferences,
        generateAudio: input.generate_audio,
        providerOptions: videoCapability.options?.({ resolution: input.resolution_name, watermark: input.watermark, size: input.size, imageUrls, videoUrls, audioUrls }) as never,
        maxRetries: 0, abortSignal: signal,
    });
    return { operation: { version: 2, binding: { providerId: model.providerId, capability: "video", upstreamModel: model.upstreamModel, baseUrl: model.baseUrl }, operation: result.operation } satisfies VideoOperation, warnings: result.warnings };
}

export async function readVideo(operation: unknown, apiKey: string, signal: AbortSignal) {
    const envelope = parseVideoOperation(operation);
    return getVideoStatus(gatewayVideoModelForBinding(envelope.binding, apiKey), { operation: envelope.operation as JSONValue, maxRetries: 0, abortSignal: signal });
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
