import { APICallError } from "ai";
import type { Experimental_VideoModelV4, Experimental_VideoModelV4File } from "@ai-sdk/provider";
import { z } from "zod";

export const gatewayFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" });

function safeBaseUrl(value: string) {
    try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        return url.toString().replace(/\/+$/, "");
    } catch {
        throw new Error("上游网关地址无效");
    }
}

export async function gatewayJson(url: string, apiKey: string, body?: unknown, signal?: AbortSignal) {
    const response = await gatewayFetch(url, {
        method: body === undefined ? "GET" : "POST", signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
    try { return JSON.parse(text) as unknown; }
    catch { throw new Error("上游返回了无效 JSON，请检查模型协议端点"); }
}

const taskSchema = z.object({
    id: z.string().optional(), request_id: z.string().optional(), status: z.string().optional(),
    error: z.object({ message: z.string().optional() }).optional(),
});
const operationSchema = z.object({ id: z.string().min(1) });

function mediaUrl(file: Experimental_VideoModelV4File) {
    return file.type === "url" ? file.url : `data:${file.mediaType};base64,${typeof file.data === "string" ? file.data : Buffer.from(file.data).toString("base64")}`;
}

// Codex2API 的 /videos 是 JSON 兼容协议，不是 OpenAI 原生 multipart 或 MiniMax /v2。
// 实现 SDK provider 接口，业务路由只调用 startVideo/getVideoStatus。
export function gatewayVideoModel(modelId: string, baseUrl: string, apiKey: string): Experimental_VideoModelV4 {
    const base = safeBaseUrl(baseUrl);
    const metadata = () => ({ timestamp: new Date(), modelId, headers: undefined });
    return {
        specificationVersion: "v4", provider: "gateway.video", modelId, maxVideosPerCall: 1,
        async doStart(options) {
            const settings = options.providerOptions.gateway || {};
            const payload: Record<string, unknown> = {
                model: modelId, prompt: options.prompt, duration: options.duration,
                resolution: settings.resolution, aspect_ratio: options.aspectRatio,
                generate_audio: options.generateAudio, watermark: settings.watermark,
            };
            const frames = options.frameImages || [];
            const first = frames.find(frame => frame.frameType === "first_frame")?.image || options.image;
            const last = frames.find(frame => frame.frameType === "last_frame")?.image;
            if (first) payload.image = { url: mediaUrl(first) };
            if (last) payload.last_frame = { url: mediaUrl(last) };
            const references = options.inputReferences || [];
            const images = references.filter(file => file.mediaType?.startsWith("image/"));
            const videos = references.filter(file => file.mediaType?.startsWith("video/"));
            const audios = references.filter(file => file.mediaType?.startsWith("audio/"));
            if (images.length) payload.reference_images = images.map(file => ({ url: mediaUrl(file) }));
            if (videos.length) payload.videos = videos.map(file => ({ url: mediaUrl(file) }));
            if (audios.length) payload.audios = audios.map(file => ({ url: mediaUrl(file) }));
            const task = taskSchema.parse(await gatewayJson(`${base}/videos`, apiKey, payload, options.abortSignal));
            const id = task.id || task.request_id;
            if (!id) throw new Error("上游未返回视频任务号");
            return { operation: { id }, warnings: [], response: metadata() };
        },
        async doStatus(options) {
            const { id } = operationSchema.parse(options.operation);
            const task = taskSchema.parse(await gatewayJson(`${base}/videos/${encodeURIComponent(id)}`, apiKey, undefined, options.abortSignal));
            const response = metadata();
            if (["failed", "cancelled", "expired"].includes(task.status || "")) {
                return { status: "error", error: task.error?.message || "视频生成失败", response };
            }
            if (["completed", "done", "succeeded"].includes(task.status || "")) {
                return { status: "completed", videos: [{ type: "url", url: `${base}/videos/${encodeURIComponent(id)}/content`, mediaType: "video/mp4" }], warnings: [], response };
            }
            return { status: "pending", response };
        },
    };
}

export async function downloadGatewayVideo(url: string, baseUrl: string, apiKey: string, signal?: AbortSignal) {
    let base: URL;
    let target: URL;
    try {
        base = new URL(safeBaseUrl(baseUrl));
        target = new URL(url, base.origin);
    } catch {
        throw new Error("上游视频地址无效");
    }
    // 中转返回的是同源鉴权 content 链接；不向外域发送账号 Key，也不跟随重定向。
    if (target.origin !== base.origin || target.username || target.password || !["http:", "https:"].includes(target.protocol)) throw new Error("上游返回了非当前网关的视频地址");
    const response = await gatewayFetch(target, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!response.ok) throw new APICallError({ message: "视频下载失败", url: target.href, requestBodyValues: undefined, statusCode: response.status, isRetryable: false });
    if (!response.headers.get("content-type")?.startsWith("video/")) throw new Error("上游没有返回有效视频内容");
    return Buffer.from(await response.arrayBuffer());
}
