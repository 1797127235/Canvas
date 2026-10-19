import { z } from "zod";
import type { DiscoveredModel } from "./contracts.js";
import { gatewayFetch } from "./transport.js";

const modelListSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1), owned_by: z.string().optional() })),
});

export async function discoverOpenAICompatibleModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
    const response = await gatewayFetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
    return modelListSchema.parse(await response.json()).data;
}
