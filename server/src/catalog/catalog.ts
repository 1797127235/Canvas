import { readFile } from "node:fs/promises";
import { z } from "zod";

export const capabilities = ["image", "video", "text", "audio"] as const;
export type Capability = typeof capabilities[number];
export const adapterIds = ["openai-chat", "openai-images", "openai-speech", "xai-images", "xai-videos", "gateway-videos"] as const;
export type AdapterId = typeof adapterIds[number];
// Each adapter serves exactly one capability; a mismatch is a configuration error, not a runtime surprise.
const adapterCapabilities: Record<AdapterId, Capability> = {
    "openai-chat": "text", "openai-images": "image", "openai-speech": "audio",
    "xai-images": "image", "xai-videos": "video", "gateway-videos": "video",
};
const modelSchema = z.strictObject({
    id: z.string().min(1), name: z.string().min(1), upstreamModel: z.string().min(1), adapter: z.enum(adapterIds),
    capability: z.enum(capabilities), enabled: z.boolean(), baseUrl: z.string().trim().min(1),
});
const schema = z.strictObject({ models: z.array(modelSchema) });
export type CatalogModel = z.infer<typeof modelSchema>;
export type Catalog = { models: CatalogModel[] };

export async function loadCatalog(path?: string, production = false): Promise<Catalog> {
    if (!path) return { models: [] };
    try {
        const input = schema.parse(JSON.parse(await readFile(path, "utf8")));
        for (const model of input.models) {
            const url = new URL(model.baseUrl);
            // 上游与上线环境一致允许 http/https，不再区分生产强制 https。
            if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error();
            if (adapterCapabilities[model.adapter] !== model.capability) throw new Error();
        }
        if (new Set(input.models.map(model => model.id)).size !== input.models.length) throw new Error();
        const models = input.models.map(model => ({ ...model, baseUrl: new URL(model.baseUrl).toString().replace(/\/+$/, "") }));
        if (new Set(models.map(model => model.baseUrl)).size > 1) throw new Error();
        return { models };
    } catch {
        throw new Error("Invalid catalog configuration");
    }
}

const upstreamModelsSchema = z.object({ data: z.array(z.object({
    id: z.string().min(1), capability: z.unknown().optional(), capabilities: z.unknown().optional(),
})) });
const capabilitySchema = z.enum(capabilities);
function adapterForModel(id: string, capability: Capability): AdapterId {
    const value = id.toLowerCase();
    if (capability === "image" && value.includes("grok-imagine")) return "xai-images";
    if (capability === "video" && value.includes("grok-imagine")) return "xai-videos";
    if (capability === "text") return "openai-chat";
    if (capability === "image") return "openai-images";
    if (capability === "audio") return "openai-speech";
    return "gateway-videos";
}

function guessCapability(name: string): Capability {
    const value = name.toLowerCase();
    if (["video", "sora", "veo", "kling", "wan", "hailuo", "seedance", "minimax-h"].some(keyword => value.includes(keyword))) return "video";
    if (["audio", "tts", "speech", "voice", "music", "sound"].some(keyword => value.includes(keyword))) return "audio";
    if (["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"].some(keyword => value.includes(keyword))) return "image";
    return "text";
}

export async function accountModels(catalog: Catalog, apiKey: string): Promise<CatalogModel[]> {
    try {
        const baseUrl = catalog.models[0]?.baseUrl;
        if (!baseUrl) throw new Error();
        const response = await fetch(`${baseUrl}/models`, {
            method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error",
        });
        if (!response.ok) throw new Error();
        const upstream = upstreamModelsSchema.parse(await response.json());
        return upstream.data.map(model => {
            const override = catalog.models.find(configured => configured.upstreamModel === model.id || configured.id === model.id);
            const metadata = capabilitySchema.safeParse(model.capability);
            const metadataList = z.array(capabilitySchema).nonempty().safeParse(model.capabilities);
            const capability = override?.capability || (metadata.success ? metadata.data : metadataList.success ? metadataList.data[0] : guessCapability(model.id));
            return {
                id: override?.id || model.id, name: override?.name || model.id, upstreamModel: model.id,
                capability, adapter: override?.adapter || adapterForModel(model.id, capability), enabled: override?.enabled ?? true, baseUrl,
            };
        });
    } catch {
        throw new Error("Upstream model discovery failed");
    }
}

export function publicModels(catalog: Catalog) {
    return catalog.models.filter(model => model.enabled).map(({ id, name, capability }) => ({ id, name, capability }));
}

export function resolveModel(catalog: Catalog, id: string, capability: Capability) {
    return catalog.models.find(model => model.enabled && model.id === id && model.capability === capability) || null;
}

