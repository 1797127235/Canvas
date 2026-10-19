import type { ImageModelV4 } from "@ai-sdk/provider";
import { convertImageModelFileToDataUri } from "@ai-sdk/provider-utils";
import { z } from "zod";
import type { ImageCapability, ModelBinding } from "../../contracts.js";
import { gatewayJson } from "../../transport.js";
import { fetchResult, readImageResult } from "./media.js";

const imageResponseSchema = z.object({
    created: z.number().optional(),
    data: z.array(z.object({
        url: z.union([z.string().url(), z.literal("")]).nullable().optional(),
        b64_json: z.string().nullable().optional(),
        revised_prompt: z.string().nullable().optional(),
    })),
});

type AgnesImageOptions = { size?: string; outputFormat?: string };

function imageSize(size: string | undefined, optionSize: string | undefined) {
    const value = optionSize || size;
    if (!value) return "1024x1024";
    if (/^[1-4]K$/i.test(value)) return value.toUpperCase();
    return /^\d+x\d+$/i.test(value) ? value : "1024x1024";
}

const imageRatios = ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9"] as const;
function imageRatio(size: string | undefined, aspectRatio: string | undefined) {
    const value = aspectRatio || size?.replace("x", ":");
    if (!value) return undefined;
    const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (!match) return undefined;
    const target = Number(match[1]) / Number(match[2]);
    return imageRatios.reduce((best, current) => {
        const [width, height] = current.split(":").map(Number);
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        return Math.abs(width / height - target) < Math.abs(bestWidth / bestHeight - target) ? current : best;
    });
}

async function readImageUrl(url: string, binding: ModelBinding, signal?: AbortSignal) {
    const response = await fetchResult(url, binding, signal);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (contentType && !["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw new Error("Agnes 图片结果格式不支持");
    return (await readImageResult(response)).toString("base64");
}

export function createImageModel(binding: ModelBinding, apiKey: string): ImageModelV4 {
    return {
        specificationVersion: "v4",
        provider: "AgnesAI",
        modelId: binding.upstreamModel,
        maxImagesPerCall: 1,
        supportsFileInputs: true,
        supportsMaskInputs: false,
        async doGenerate(options) {
            const providerOptions = (options.providerOptions.AgnesAI || {}) as AgnesImageOptions;
            const images = options.files?.map(convertImageModelFileToDataUri);
            const body = {
                model: binding.upstreamModel,
                ...(options.prompt ? { prompt: options.prompt } : {}),
                size: imageSize(options.size, providerOptions.size),
                ...(imageRatio(options.size, options.aspectRatio) ? { ratio: imageRatio(options.size, options.aspectRatio) } : {}),
                extra_body: {
                    ...(images?.length ? { image: images } : {}),
                    response_format: "b64_json",
                },
            };
            const result = await gatewayJson(`${binding.baseUrl.replace(/\/+$/, "")}/images/generations`, apiKey, body, options.abortSignal, options.headers);
            const response = imageResponseSchema.parse(result.value);
            const imagesResult = await Promise.all(response.data.map(async item => {
                if (item.b64_json) return item.b64_json;
                if (item.url) return readImageUrl(item.url, binding, options.abortSignal);
                throw new Error("Agnes 图片接口没有返回图像");
            }));
            return {
                images: imagesResult,
                warnings: [
                    ...(options.mask ? [{ type: "unsupported" as const, feature: "mask", details: "Agnes 图片接口未适配蒙版输入" }] : []),
                ],
                response: { timestamp: new Date(), modelId: binding.upstreamModel, headers: Object.fromEntries(result.headers) },
                providerMetadata: { AgnesAI: { images: response.data.map(item => ({ revisedPrompt: item.revised_prompt || undefined })) } },
            };
        },
    };
}

export const agnesImageCapability = {
    model: createImageModel,
    maxImagesPerCall: 1,
    aspectRatios: ["1:1", "2:3", "3:2", "4:3", "3:4", "16:9", "9:16", "21:9"],
    options: ({ size, outputFormat }) => ({ AgnesAI: { ...(size ? { size } : {}), ...(outputFormat ? { outputFormat } : {}) } }),
} satisfies ImageCapability;
