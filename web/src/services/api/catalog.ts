import { z } from "zod";

const modelSpecSchema = z.object({
    canonicalId: z.string().min(1), source: z.literal("models.dev"), name: z.string().optional(),
    limit: z.object({ context: z.number().int().nonnegative(), input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative() }),
    toolCall: z.boolean().optional(), reasoning: z.boolean().optional(), structuredOutput: z.boolean().optional(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
    lastUpdated: z.string().optional(),
});
const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string(), capability: z.enum(["image", "video", "text", "audio"]), spec: modelSpecSchema.optional() })) });
export type PublicModel = z.infer<typeof modelsSchema>["models"][number];

export async function fetchServerModels() {
    const response = await fetch("/api/models", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message || "服务端模型目录读取失败");
    }
    return modelsSchema.parse(await response.json()).models;
}
