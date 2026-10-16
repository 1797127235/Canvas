import { APICallError } from "ai";
import { Readable } from "node:stream";
import type { Experimental_VideoModelV4, Experimental_VideoModelV4File } from "@ai-sdk/provider";
import { fetchWithValidatedRedirects } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { videoProtocols, type VideoProtocol } from "../catalog/catalog.js";

// 只允许 http/https 出站；调用方传入的地址都已由 safeBaseUrl / 协议端点拼接校验。
export const gatewayFetch: typeof fetch = (input, init) => {
    try {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        return fetch(url, { ...init, redirect: "error" });
    } catch {
        throw new Error("上游网关地址无效");
    }
};

// 上游按模型登记的视频协议，字段不能互相套用：
// - ark：火山方舟 `content` 数组（doubao-seedance 系；日志实测 201 受理）
// - minimax：MiniMax 原生 `/v2/video_generation`（MiniMax-H3-Max / H3-open）
// - openai：[OI] Videos `/v1/videos`（seedance-2.x 与 MiniMax-H3）
// 只有 `doubao-seedance` 系登记了方舟端点；`seedance-2.x` 只登记 `/v1/videos`（发方舟会被判无可用账号）。
// catalog 可用 `videoProtocol` 显式覆盖，不做静默改写。
export function videoProtocolFor(modelId: string): VideoProtocol {
    const value = modelId.toLowerCase();
    if (value.includes("h3-max") || value.includes("h3-open")) return "minimax";
    if (value.startsWith("doubao-seedance")) return "ark";
    return "openai";
}

// 秘塔 H3 只认 768p / 2K 两个档位（文档：1280x720、720x1280 对应 768p；1792x1024、1024x1792 对应 2K）。
// 面板给的是 480p/720p/1080p，这里按档位就近归到 H3 支持的档，不支持的方形尺寸不自行编造。
function metasoResolution(value?: string) {
    if (!value) return "768p";
    return /1080|2k|4k/i.test(value) ? "2k" : "768p";
}
function isMetaso(modelId: string) {
    return modelId.toLowerCase().includes("h3");
}
// seedance-2.5 实测不接受 size（如 1280x720），接受 resolution + ratio。
function isSeedance(modelId: string) {
    return modelId.toLowerCase().startsWith("seedance-");
}

function safeBaseUrl(value: string) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        return url.toString().replace(/\/+$/, "");
    } catch {
        throw new Error("上游网关地址无效");
    }
}

type GatewayResponse = { value: unknown; headers: Headers };

export async function gatewayJson(url: string, apiKey: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string | undefined>): Promise<GatewayResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    for (const [key, value] of Object.entries(extra || {})) if (value !== undefined) headers[key] = value;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await gatewayFetch(url, {
        method: body === undefined ? "GET" : "POST", signal, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        let message = "上游生成失败，请检查模型和参数";
        try {
            const payload = JSON.parse(text);
            message = payload.error?.message || payload.message || message;
        } catch {
            // 上游不可用时网关（Cloudflare 等）返回的是 HTML 错误页，只保留状态码，不回显 HTML 正文。
            message = response.status >= 500 ? "上游服务暂时不可用，请稍后重试" : `上游返回了无法解析的错误（HTTP ${response.status}）`;
        }
        throw new APICallError({ message, url, requestBodyValues: undefined, statusCode: response.status, responseBody: text, isRetryable: false });
    }
    try { return { value: JSON.parse(text) as unknown, headers: response.headers }; }
    catch {
        // 上游返回非 JSON（网关 HTML 页、空响应等）：状态码与正文交给上游日志，用户侧只看到一句可读结论。
        throw new APICallError({ message: "上游返回了非 JSON 响应，请检查模型协议端点", url, requestBodyValues: undefined, statusCode: response.status, responseBody: text, isRetryable: false });
    }
}

const taskSchema = z.object({
    id: z.string().optional(), request_id: z.string().optional(), status: z.string().optional(),
    error: z.object({ message: z.string().optional() }).optional(),
});
const minimaxTaskSchema = z.object({
    task_id: z.string().optional(), status: z.string().optional(),
    base_resp: z.object({ status_code: z.number().optional(), status_msg: z.string().optional() }).optional(),
});
const minimaxStatusSchema = z.object({
    task_id: z.string().optional(), status: z.string().optional(),
    data: z.object({ video_url: z.string().optional() }).nullish(),
    base_resp: z.object({ status_code: z.number().optional(), status_msg: z.string().optional() }).optional(),
});
const arkStatusSchema = z.object({
    id: z.string().optional(), status: z.string().optional(),
    content: z.object({ video_url: z.string().optional() }).nullish(),
    error: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
});
const operationSchema = z.object({ protocol: z.enum(videoProtocols).optional(), id: z.string().min(1), vid: z.string().optional() });
const COMPLETED = ["completed", "done", "succeeded", "success"];
const FAILED = ["failed", "cancelled", "canceled", "expired", "error", "fail"];

function mediaUrl(file: Experimental_VideoModelV4File) {
    return file.type === "url" ? file.url : `data:${file.mediaType};base64,${typeof file.data === "string" ? file.data : Buffer.from(file.data).toString("base64")}`;
}

type VideoInputs = {
    prompt: string | undefined; duration: number | undefined; aspectRatio: string | undefined;
    size: string | undefined; resolution: string | undefined; generateAudio: boolean | undefined; watermark: boolean | undefined; imageUrls: string[];
    frames: { first?: string; last?: string };
    images: string[]; videos: string[]; audios: string[];
};

function collectInputs(options: Parameters<NonNullable<Experimental_VideoModelV4["doStart"]>>[0]): VideoInputs {
    const settings = options.providerOptions.gateway || {};
    const frames = options.frameImages || [];
    const first = frames.find(frame => frame.frameType === "first_frame")?.image || options.image;
    const last = frames.find(frame => frame.frameType === "last_frame")?.image;
    const references = options.inputReferences || [];
    const of = (prefix: string) => references.filter(file => file.mediaType?.startsWith(prefix)).map(mediaUrl);
    return {
        prompt: options.prompt, duration: options.duration, aspectRatio: options.aspectRatio,
        size: typeof settings.size === "string" ? settings.size : undefined,
        resolution: typeof settings.resolution === "string" ? settings.resolution : undefined,
        generateAudio: options.generateAudio, watermark: typeof settings.watermark === "boolean" ? settings.watermark : undefined,
        imageUrls: Array.isArray(settings.imageUrls) ? settings.imageUrls.filter((url): url is string => typeof url === "string") : [],
        frames: { first: first ? mediaUrl(first) : undefined, last: last ? mediaUrl(last) : undefined },
        images: of("image/"), videos: of("video/"), audios: of("audio/"),
    };
}

// OpenAI Videos（/v1/videos）：尺寸用 size 或 resolution+ratio 二选一，参考图单张走 input_reference、多张走 images 中继字段。
function openaiPayload(modelId: string, input: VideoInputs) {
    const payload: Record<string, unknown> = { model: modelId, prompt: input.prompt };
    if (input.duration != null) payload.seconds = input.duration;
    if (isMetaso(modelId)) {
        payload.resolution = metasoResolution(input.resolution);
        if (input.aspectRatio) payload.ratio = input.aspectRatio;
    } else if (isSeedance(modelId)) {
        if (input.resolution) payload.resolution = input.resolution;
        if (input.aspectRatio) payload.ratio = input.aspectRatio;
    } else if (input.size) {
        payload.size = input.size;
    } else {
        if (input.resolution) payload.resolution = input.resolution;
        if (input.aspectRatio) payload.ratio = input.aspectRatio;
    }
    const images = (isSeedance(modelId) && input.imageUrls.length ? input.imageUrls : [input.frames.first, input.frames.last].filter((url): url is string => Boolean(url)).concat(input.images));
    // seedance-2.5 实测：参考图放 images 字符串数组；秘塔 H3 文档要求 input_reference.image_url。
    if (images.length === 1 && isMetaso(modelId)) payload.input_reference = { image_url: images[0] };
    else if (images.length) payload.images = images;
    if (input.videos.length) payload.videos = input.videos.map(url => ({ url }));
    if (input.audios.length) payload.audios = input.audios.map(url => ({ url }));
    if (input.generateAudio != null) payload.generate_audio = input.generateAudio;
    if (input.watermark != null) payload.watermark = input.watermark;
    return payload;
}

// 火山方舟与 MiniMax 原生都用 content 数组，只是参数名不同（方舟 resolution/ratio，MiniMax aigc_watermark）。
function contentPayload(modelId: string, input: VideoInputs, protocol: "ark" | "minimax") {
    const content: Array<Record<string, unknown>> = [{ type: "text", text: input.prompt ?? "" }];
    if (input.frames.first) content.push({ type: "image_url", image_url: { url: input.frames.first }, role: "first_frame" });
    if (input.frames.last) content.push({ type: "image_url", image_url: { url: input.frames.last }, role: "last_frame" });
    for (const url of input.images) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    for (const url of input.videos) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    for (const url of input.audios) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    const payload: Record<string, unknown> = { model: modelId, content };
    if (input.duration != null) payload.duration = input.duration;
    if (input.resolution) payload.resolution = input.resolution;
    if (input.aspectRatio) payload.ratio = input.aspectRatio;
    if (protocol === "ark") {
        if (input.generateAudio != null) payload.generate_audio = input.generateAudio;
        if (input.watermark != null) payload.watermark = input.watermark;
    } else if (input.watermark != null) payload.aigc_watermark = input.watermark;
    return payload;
}

function endpoints(protocol: VideoProtocol, base: string) {
    // base 已由 safeBaseUrl 校验，这里只取同源根地址拼原生路径。
    let origin: string;
    try { origin = new URL(base).origin; } catch { throw new Error("上游网关地址无效"); }
    if (protocol === "ark") return { create: `${origin}/api/v3/contents/generations/tasks`, status: (id: string) => `${origin}/api/v3/contents/generations/tasks/${encodeURIComponent(id)}` };
    if (protocol === "minimax") return { create: `${origin}/v2/video_generation`, status: (id: string) => `${origin}/v2/query/video_generation/${encodeURIComponent(id)}` };
    return { create: `${base}/videos`, status: (id: string) => `${base}/videos/${encodeURIComponent(id)}` };
}

export function gatewayVideoModel(modelId: string, baseUrl: string, apiKey: string, protocol: VideoProtocol = videoProtocolFor(modelId)): Experimental_VideoModelV4 {
    const base = safeBaseUrl(baseUrl);
    const metadata = () => ({ timestamp: new Date(), modelId, headers: undefined });
    return {
        specificationVersion: "v4", provider: "gateway.video", modelId, maxVideosPerCall: 1,
        async doStart(options) {
            const input = collectInputs(options);
            const payload = protocol === "openai" ? openaiPayload(modelId, input) : contentPayload(modelId, input, protocol);
            const { value, headers } = await gatewayJson(endpoints(protocol, base).create, apiKey, payload, options.abortSignal, options.headers);
            // 方舟与 MiniMax 响应头带本站 vid_… 统一任务号；原生任务号仍用于原生查询路径。
            const vid = headers.get("x-video-task-id") || undefined;
            const id = protocol === "minimax" ? minimaxTaskSchema.parse(value).task_id : taskSchema.parse(value).id || taskSchema.parse(value).request_id;
            if (!id) throw new Error("上游未返回视频任务号");
            return { operation: { protocol, id, ...(vid && vid !== id ? { vid } : {}) }, warnings: [], response: metadata() };
        },
        async doStatus(options) {
            const saved = operationSchema.parse(options.operation);
            const active = saved.protocol || protocol;
            if (active === "minimax") {
                const { value } = await gatewayJson(endpoints("minimax", base).status(saved.id), apiKey, undefined, options.abortSignal);
                const task = minimaxStatusSchema.parse(value);
                const response = metadata();
                // HTTP 200 不代表成功，MiniMax 用 base_resp 表达业务错误。
                if (task.base_resp?.status_code) return { status: "error", error: task.base_resp.status_msg || "视频生成失败", response };
                const status = (task.status || "").toLowerCase();
                if (FAILED.includes(status)) return { status: "error", error: "视频生成失败", response };
                if (!COMPLETED.includes(status)) return { status: "pending", response };
                const url = task.data?.video_url || (saved.vid ? `${base}/videos/${encodeURIComponent(saved.vid)}/content` : undefined);
                if (!url) throw new Error("上游没有返回视频下载地址");
                return { status: "completed", videos: [{ type: "url", url, mediaType: "video/mp4" }], warnings: [], response };
            }
            if (active === "ark") {
                const { value } = await gatewayJson(endpoints("ark", base).status(saved.id), apiKey, undefined, options.abortSignal);
                const task = arkStatusSchema.parse(value);
                const response = metadata();
                const status = (task.status || "").toLowerCase();
                if (FAILED.includes(status)) return { status: "error", error: task.error?.message || "视频生成失败", response };
                if (!COMPLETED.includes(status)) return { status: "pending", response };
                const url = task.content?.video_url || (saved.vid ? `${base}/videos/${encodeURIComponent(saved.vid)}/content` : undefined);
                if (!url) throw new Error("上游没有返回视频下载地址");
                return { status: "completed", videos: [{ type: "url", url, mediaType: "video/mp4" }], warnings: [], response };
            }
            const { value } = await gatewayJson(endpoints("openai", base).status(saved.id), apiKey, undefined, options.abortSignal);
            const task = taskSchema.parse(value);
            const response = metadata();
            if (FAILED.includes((task.status || "").toLowerCase())) return { status: "error", error: task.error?.message || "视频生成失败", response };
            if (COMPLETED.includes((task.status || "").toLowerCase())) return { status: "completed", videos: [{ type: "url", url: `${base}/videos/${encodeURIComponent(saved.id)}/content`, mediaType: "video/mp4" }], warnings: [], response };
            return { status: "pending", response };
        },
    };
}

// 返回流而不是完整 Buffer：调用方直接 pipeline 进媒体存储，不在 api 进程里整块持有视频。
export async function downloadGatewayVideo(url: string, baseUrl: string, apiKey: string, signal?: AbortSignal) {
    let base: URL;
    let target: URL;
    try {
        base = new URL(safeBaseUrl(baseUrl));
        target = new URL(url, base.origin);
    } catch {
        throw new Error("上游视频地址无效");
    }
    const trusted = target.origin === base.origin && !target.username && !target.password && ["http:", "https:"].includes(target.protocol);
    let response: Response;
    if (trusted) {
        // 中转返回的是同源鉴权 content 链接；不向外域发送账号 Key，也不跟随重定向。
        response = await gatewayFetch(target, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    } else {
        // 方舟 / MiniMax 可能直接返回厂商 CDN 地址：这里校验并固定 DNS，跨域不携带 Key。
        try {
            response = await fetchWithValidatedRedirects({ url: target.toString(), abortSignal: signal, trustedOrigin: base.origin });
        } catch {
            throw new Error("上游返回了不安全的视频地址");
        }
    }
    if (!response.ok) throw new APICallError({ message: "视频下载失败", url: target.href, requestBodyValues: undefined, statusCode: response.status, isRetryable: false });
    const contentType = response.headers.get("content-type")?.split(";")[0] || "";
    if (!contentType.startsWith("video/") && contentType !== "application/octet-stream") throw new Error("上游没有返回有效视频内容");
    if (!response.body) throw new Error("上游没有返回有效视频内容");
    return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}
