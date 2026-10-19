import { z } from "zod";

const MODEL_SPEC_URL = "https://models.dev/models.json";
const CACHE_MS = 60 * 60 * 1000;

const limitSchema = z.object({ context: z.number().int().nonnegative(), input: z.number().int().nonnegative().optional(), output: z.number().int().nonnegative() });
const specSchema = z.object({
    name: z.string().min(1).optional(),
    reasoning: z.boolean().optional(), tool_call: z.boolean().optional(), structured_output: z.boolean().optional(),
    modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }).optional(),
    limit: limitSchema,
    last_updated: z.string().optional(),
});

export type ModelSpec = {
    canonicalId: string;
    name?: string;
    reasoning?: boolean;
    toolCall?: boolean;
    structuredOutput?: boolean;
    modalities?: { input: string[]; output: string[] };
    limit: { context: number; input?: number; output: number };
    lastUpdated?: string;
    source: "models.dev";
};

export type ModelsDevFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type ModelsDevSpecs = ReadonlyMap<string, ModelSpec>;
export type ModelsDevLoader = () => Promise<ModelsDevSpecs>;

export function createModelsDevLoader(fetcher: ModelsDevFetcher = fetch, clock = () => Date.now()) {
    let cache: { expiresAt: number; specs: ModelsDevSpecs } | null = null;
    let pending: Promise<ModelsDevSpecs> | null = null;
    return async (): Promise<ModelsDevSpecs> => {
        if (cache && cache.expiresAt > clock()) return cache.specs;
        if (pending) return pending;
        pending = fetchModelsDev(fetcher).then((specs) => {
            cache = { expiresAt: clock() + CACHE_MS, specs };
            return specs;
        }).catch(() => {
            const empty = new Map<string, ModelSpec>();
            cache = { expiresAt: clock() + 60_000, specs: empty };
            return empty;
        }).finally(() => { pending = null; });
        return pending;
    };
}

async function fetchModelsDev(fetcher: ModelsDevFetcher): Promise<ModelsDevSpecs> {
    const response = await fetcher(MODEL_SPEC_URL, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Models.dev returned ${response.status}`);
    const root = z.record(z.string(), z.unknown()).parse(await response.json());
    const specs = new Map<string, ModelSpec>();
    for (const [key, value] of Object.entries(root)) {
        const parsed = specSchema.safeParse(value);
        if (!parsed.success) continue;
        const model = parsed.data;
        const canonicalId = key;
        specs.set(canonicalId, {
            canonicalId, name: model.name, reasoning: model.reasoning, toolCall: model.tool_call,
            structuredOutput: model.structured_output, modalities: model.modalities, limit: model.limit,
            lastUpdated: model.last_updated, source: "models.dev",
        });
    }
    return specs;
}

export function findModelSpec(specs: ModelsDevSpecs, modelId: string, providerId?: string) {
    const direct = specs.get(modelId) ?? (providerId ? specs.get(`${providerId}/${modelId}`) : undefined);
    if (direct) return direct;
    const matches = [...specs.values()].filter((spec) => spec.canonicalId.endsWith(`/${modelId}`));
    return matches.length === 1 ? matches[0] : undefined;
}
