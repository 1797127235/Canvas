import { z } from "zod";

const imageResponseSchema = z.object({ data: z.array(z.record(z.string(), z.unknown())).optional() });

export async function requestServerImageGeneration(modelId: string, input: Record<string, unknown>) {
    const response = await fetch("/api/generations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ capability: "image", modelId, input }),
    });
    if (!response.ok) {
        let message = "服务端生成失败";
        try {
            const payload = (await response.json()) as { error?: { message?: string } };
            message = payload.error?.message || message;
        } catch {
            // Preserve a generic message when the upstream response is not JSON.
        }
        throw new Error(message);
    }
    const payload = imageResponseSchema.parse(await response.json());
    const images = (payload.data || []).map((item, index) => {
        const dataUrl = typeof item.b64_json === "string" ? `data:image/png;base64,${item.b64_json}` : typeof item.url === "string" ? item.url : "";
        return dataUrl ? { id: `server-image-${index}`, dataUrl } : null;
    }).filter((value): value is { id: string; dataUrl: string } => Boolean(value));
    if (!images.length) throw new Error("服务端没有返回图片");
    return images;
}
