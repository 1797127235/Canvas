import { z } from "zod";

const modelsSchema = z.object({ models: z.array(z.object({ id: z.string(), name: z.string(), capability: z.enum(["image", "video", "text", "audio"]) })) });
export type PublicModel = z.infer<typeof modelsSchema>["models"][number];

export async function fetchServerModels() {
    const response = await fetch("/api/models", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("服务端模型目录读取失败");
    return modelsSchema.parse(await response.json()).models;
}
