import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderDefinition } from "../../contracts.js";
import { gatewayFetch } from "../../transport.js";
import { discoverOpenAICompatibleModels } from "../../discovery.js";
import { c2aVideoCapability } from "./video.js";

export const c2aProvider = {
    id: "C2A",
    discoverModels: discoverOpenAICompatibleModels,
    capabilities: {
        text: {
            model: (binding, apiKey) => createOpenAI({ name: "C2A", baseURL: binding.baseUrl, apiKey, fetch: gatewayFetch }).chat(binding.upstreamModel),
            options: ({ reasoningEffort }) => ({ openai: { reasoningEffort } }),
        },
        image: {
            model: (binding, apiKey) => createOpenAI({ name: "C2A", baseURL: binding.baseUrl, apiKey, fetch: gatewayFetch }).imageModel(binding.upstreamModel),
        },
        video: c2aVideoCapability,
    },
} satisfies ProviderDefinition;