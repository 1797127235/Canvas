import type { ModelBinding } from "../../contracts.js";
import { gatewayFetch } from "../../transport.js";

const MAX_IMAGE_RESULT_BYTES = 25 * 1024 * 1024;

// 官方图片示例使用 storage.googleapis.com/agnes-aigc，CN 视频实测使用 cos-platform-outputs.agnes-ai.cn。
// 结果下载不携带账号 Key。
// https://wiki.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash
export async function fetchResult(url: string, binding: ModelBinding, signal?: AbortSignal) {
    let target: URL;
    let base: URL;
    try {
        target = new URL(url);
        base = new URL(binding.baseUrl);
    } catch {
        throw new Error("Agnes 结果下载地址无效");
    }
    const trusted = target.origin === base.origin
        || target.hostname === "agnes-ai.com" || target.hostname.endsWith(".agnes-ai.com")
        || target.hostname === "cos-platform-outputs.agnes-ai.cn"
        || (target.hostname === "storage.googleapis.com" && target.pathname.startsWith("/agnes-aigc/"));
    if (target.protocol !== "https:" || target.username || target.password || !trusted || target.port && target.port !== "443") {
        throw new Error("Agnes 结果下载地址无效或不在可信存储范围内");
    }
    const response = await gatewayFetch(target, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Agnes 结果下载失败（HTTP ${response.status}）`);
    return response;
}

export async function readImageResult(response: Response) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_RESULT_BYTES) throw new Error("Agnes 图片结果过大");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Agnes 图片结果为空");
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_IMAGE_RESULT_BYTES) throw new Error("Agnes 图片结果过大");
            chunks.push(Buffer.from(value));
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}
