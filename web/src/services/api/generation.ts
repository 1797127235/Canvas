import { z } from "zod";
import { nanoid } from "nanoid";

const responseSchema = z.record(z.string(), z.unknown());
const imageResponseSchema = z.object({ data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().url().optional() })) });

export async function requestServerGeneration(capability: "image" | "video" | "audio" | "text", modelId: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch("/api/generations", {
        method: "POST", signal,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ capability, modelId, input }),
    });
    if (!response.ok) throw await readGenerationError(response);
    return responseSchema.parse(await response.json());
}

export async function pollServerGeneration(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/generations/${encodeURIComponent(id)}`, { credentials: "same-origin", signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw await readGenerationError(response);
    return responseSchema.parse(await response.json());
}

export async function fetchServerGenerationContent(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/generations/${encodeURIComponent(id)}/content`, { credentials: "same-origin", signal });
    if (!response.ok) throw await readGenerationError(response);
    return response.blob();
}

export async function requestServerImageGeneration(modelId: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const payload = await requestServerGeneration("image", modelId, input, signal);
    const parsed = imageResponseSchema.parse(payload);
    const images = parsed.data.map((item) => {
        const dataUrl = typeof item.b64_json === "string" ? `data:image/png;base64,${item.b64_json}` : typeof item.url === "string" ? item.url : "";
        return dataUrl ? { id: nanoid(), dataUrl } : null;
    }).filter((value): value is { id: string; dataUrl: string } => Boolean(value));
    if (!images.length) throw new Error("服务端没有返回图片");
    return images;
}

async function readGenerationError(response: Response) {
    try {
        const payload = (await response.json()) as { error?: { message?: string } };
        return new Error(payload.error?.message || "服务端生成失败");
    } catch {
        return new Error("服务端生成失败");
    }
}
