import { z } from "zod";
import { gatewayJson } from "./gateway-video.js";

// 火山方舟图片生成是同步接口：POST {base}/images/generations 直接返回结果，没有任务号可轮询。
// 参考图与提示词在同一个 JSON body 里（image 为 string | string[]），不是 [OI] 的 /images/edits multipart，
// 所以这里不用 AI SDK 的 ImageModel，直接按方舟原生协议收发。
const responseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().min(1) })).nonempty() });

// 方舟要求总像素落在 [921600, 4624220]，而前端面板允许的档位超出这个区间：
// 1k 4:3 = 1024x768 偏小、4k 16:9 = 3840x2160 偏大，两者都会被上游以 InvalidParameter 拒绝。
// 这里按比例把尺寸夹进区间并对齐 16，保证面板上任何档位都能发出一次成功的请求；宽高比沿用面板值（面板已限制在 3 以内）。
const MIN_PIXELS = 921600;
const MAX_PIXELS = 4624220;
const SIZE_STEP = 16;

export function arkImageSize(size?: string) {
    const match = (size || "").match(/^(\d+)x(\d+)$/);
    if (!match) return undefined;
    let width = Number(match[1]);
    let height = Number(match[2]);
    if (!width || !height) return undefined;
    const pixels = width * height;
    if (pixels < MIN_PIXELS) {
        const scale = Math.sqrt(MIN_PIXELS / pixels);
        width = Math.ceil((width * scale) / SIZE_STEP) * SIZE_STEP;
        height = Math.ceil((height * scale) / SIZE_STEP) * SIZE_STEP;
    } else if (pixels > MAX_PIXELS) {
        const scale = Math.sqrt(MAX_PIXELS / pixels);
        width = Math.floor((width * scale) / SIZE_STEP) * SIZE_STEP;
        height = Math.floor((height * scale) / SIZE_STEP) * SIZE_STEP;
    }
    return `${width}x${height}`;
}

const OUTPUT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

// 方舟一次请求只出一张图，前端面板的「生成 N 张」按 N 次独立调用展开。
export async function arkImages(options: {
    baseUrl: string; apiKey: string; modelId: string; prompt: string;
    images: string[]; size?: string; outputFormat?: string; count: number; signal?: AbortSignal;
}) {
    const size = arkImageSize(options.size);
    const outputFormat = options.outputFormat && OUTPUT_MIME[options.outputFormat] ? options.outputFormat : "png";
    const calls = Array.from({ length: options.count }, async () => {
        const { value } = await gatewayJson(`${options.baseUrl}/images/generations`, options.apiKey, {
            model: options.modelId, prompt: options.prompt,
            ...(options.images.length ? { image: options.images } : {}),
            ...(size ? { size } : {}),
            output_format: outputFormat, response_format: "b64_json", watermark: false,
        }, options.signal);
        return responseSchema.parse(value).data.map(image => ({ b64_json: image.b64_json, mime_type: OUTPUT_MIME[outputFormat] }));
    });
    return { data: (await Promise.all(calls)).flat(), warnings: [] };
}
