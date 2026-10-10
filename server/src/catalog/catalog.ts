import { readFile } from "node:fs/promises";
import { z } from "zod";

export const capabilities = ["image", "video", "text", "audio"] as const;
export type Capability = typeof capabilities[number];
export const adapterIds = ["openai-chat", "openai-images", "openai-speech", "openai-videos"] as const;
export type AdapterId = typeof adapterIds[number];
const modelSchema = z.strictObject({ id: z.string().min(1), name: z.string().min(1), upstreamModel: z.string().min(1), adapter: z.enum(adapterIds), capability: z.enum(capabilities), enabled: z.boolean() });
const schema = z.strictObject({ upstream: z.strictObject({ baseUrl: z.url() }), models: z.array(modelSchema) });
export type Catalog = { baseUrl: string; models: z.infer<typeof modelSchema>[] };

export async function loadCatalog(path?: string, production = false): Promise<Catalog> {
    if (!path) return { baseUrl: "", models: [] };
    try {
        const input = schema.parse(JSON.parse(await readFile(path, "utf8")));
        const url = new URL(input.upstream.baseUrl);
        if (url.username || url.password || url.search || url.hash || (production && url.protocol !== "https:") || (!production && !["http:", "https:"].includes(url.protocol))) throw new Error();
        if (new Set(input.models.map(model => model.id)).size !== input.models.length) throw new Error();
        return { baseUrl: url.toString().replace(/\/$/, ""), models: input.models };
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

export function upstreamUrl(catalog: Catalog, path: string) {
    return `${catalog.baseUrl}/${path}`;
}
