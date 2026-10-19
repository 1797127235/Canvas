import { z } from "zod";
import type { ProviderDefinition } from "../../src/gateway/contracts.js";
import type { createRegistry } from "../../src/gateway/registry.js";

const operationSchema = z.strictObject({ task: z.string() });
const model = { specificationVersion: "v4", provider: "test-provider", modelId: "test-model" } as never;
export const testProvider: ProviderDefinition = {
    id: "test-provider",
    discoverModels: async (baseUrl, apiKey) => {
        const response = await fetch(`${baseUrl}/models`, { method: "GET", headers: { authorization: `Bearer ${apiKey}` }, redirect: "error" });
        if (!response.ok) throw new Error("model discovery failed");
        return z.object({ data: z.array(z.object({ id: z.string().min(1), capability: z.unknown().optional(), capabilities: z.unknown().optional(), owned_by: z.string().optional() })) }).parse(await response.json()).data;
    },
    capabilities: {
        text: { model: () => model },
        image: { model: () => model },
        audio: { model: () => model },
        video: {
            model: () => model,
            operationSchema,
            download: async () => { throw new Error("test download not configured"); },
        },
    },
};

export function registerTestProvider(registry: ReturnType<typeof createRegistry>) {
    registry.registerProvider(testProvider);
}
