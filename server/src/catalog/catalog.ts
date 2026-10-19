import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ModelSpec } from "./models-dev.js";
import { gateway } from "../gateway/index.js";
import { capabilities, type Capability } from "../gateway/contracts.js";
export { capabilities, type Capability, type ProviderId } from "../gateway/contracts.js";

const modelSchema = z.strictObject({
    id: z.string().min(1), name: z.string().min(1), upstreamModel: z.string().min(1), providerId: gateway.providerIdSchema,
    capability: z.enum(capabilities), enabled: z.boolean(), baseUrl: z.string().trim().min(1),
});
const schema = z.strictObject({ discoveryProviderId: gateway.providerIdSchema.optional(), models: z.array(modelSchema) });
export type CatalogModel = z.infer<typeof modelSchema> & { spec?: ModelSpec; specProviderId?: string };
export type Catalog = { discoveryProviderId?: string; models: CatalogModel[] };

export async function loadCatalog(path?: string, _production = false): Promise<Catalog> {
    if (!path) return { models: [] };
    try {
        const input = schema.parse(JSON.parse(await readFile(path, "utf8")));
        for (const model of input.models) {
            const url = new URL(model.baseUrl);
            if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error();
        }
        if (new Set(input.models.map(model => model.id)).size !== input.models.length) throw new Error();
        const models = input.models.map(model => ({ ...model, baseUrl: new URL(model.baseUrl).toString().replace(/\/+$/, "") }));
        if (new Set(models.map(model => model.baseUrl)).size > 1) throw new Error();
        return { discoveryProviderId: input.discoveryProviderId, models };
    } catch {
        throw new Error("Invalid catalog configuration");
    }
}

const capabilitySchema = z.enum(capabilities);
// OpenAI 兼容上游通常不在 /models 里声明能力，按模型名关键词兜底，与前端本地模式 guessCapability 规则一致。
const capabilityKeywords: readonly [Capability, readonly string[]][] = [
    ["video", ["video", "sora", "veo", "kling", "wan", "hailuo", "seedance", "minimax-h"]],
    ["audio", ["audio", "tts", "speech", "voice", "music", "sound"]],
    ["image", ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"]],
];
function inferCapability(id: string): Capability {
    const value = id.toLowerCase();
    return capabilityKeywords.find(([, keywords]) => keywords.some(keyword => value.includes(keyword)))?.[0] ?? "text";
}
export async function accountModels(catalog: Catalog, apiKey: string, accountBaseUrl?: string | null): Promise<CatalogModel[]> {
    try {
        const baseUrl = accountBaseUrl || catalog.models[0]?.baseUrl;
        const discoveryProviderId = catalog.discoveryProviderId || catalog.models[0]?.providerId;
        if (!baseUrl || !discoveryProviderId) throw new Error();
        const upstream = await gateway.discoverModels(baseUrl, apiKey, discoveryProviderId);
        return upstream.flatMap(model => {
            const override = catalog.models.find(configured => configured.upstreamModel === model.id || configured.id === model.id);
            const capability = override?.capability || capabilitySchema.safeParse(model.capability).data || z.array(capabilitySchema).nonempty().safeParse(model.capabilities).data?.[0] || inferCapability(model.id);
            return [{
                id: override?.id || model.id, name: override?.name || model.id, upstreamModel: model.id,
                providerId: override?.providerId || discoveryProviderId, capability,
                enabled: override?.enabled ?? true, baseUrl,
                ...(model.owned_by ? { specProviderId: model.owned_by } : {}),
            }];
        });
    } catch {
        throw new Error("Upstream model discovery failed");
    }
}

export function publicModels(catalog: Catalog) {
    return catalog.models.filter(model => model.enabled).map(({ id, name, capability, spec }) => ({ id, name, capability, ...(spec ? { spec } : {}) }));
}

export function resolveModel(catalog: Catalog, id: string, capability: Capability) {
    return catalog.models.find(model => model.enabled && model.id === id && model.capability === capability) || null;
}
