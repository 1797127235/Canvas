import { readFile } from "node:fs/promises";
import { z } from "zod";

export const capabilities = ["image", "video", "text", "audio"] as const;
export type Capability = typeof capabilities[number];
export const adapterIds = ["openai-chat", "openai-images", "openai-speech", "openai-videos", "minimax-videos"] as const;
export type AdapterId = typeof adapterIds[number];
// Each adapter serves exactly one capability; a mismatch is a configuration error, not a runtime surprise.
const adapterCapabilities: Record<AdapterId, Capability> = {
    "openai-chat": "text", "openai-images": "image", "openai-speech": "audio", "openai-videos": "video", "minimax-videos": "video",
};
const modelSchema = z.strictObject({
    id: z.string().min(1), name: z.string().min(1), upstreamModel: z.string().min(1), adapter: z.enum(adapterIds),
    capability: z.enum(capabilities), enabled: z.boolean(), baseUrl: z.string().trim().min(1), apiKey: z.string().trim().min(1),
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
            if (url.username || url.password || url.search || url.hash || (production && url.protocol !== "https:") || (!production && !["http:", "https:"].includes(url.protocol))) throw new Error();
            if (adapterCapabilities[model.adapter] !== model.capability) throw new Error();
        }
        if (new Set(input.models.map(model => model.id)).size !== input.models.length) throw new Error();
        return { models: input.models.map(model => ({ ...model, baseUrl: new URL(model.baseUrl).toString().replace(/\/$/, "") })) };
    } catch {
        throw new Error("Invalid catalog configuration");
    }
}

export function publicModels(catalog: Catalog) {
    return catalog.models.filter(model => model.enabled).map(({ id, name, capability }) => ({ id, name, capability }));
}

export function resolveModel(catalog: Catalog, id: string, capability: Capability) {
    return catalog.models.find(model => model.enabled && model.id === id && model.capability === capability) || null;
}

