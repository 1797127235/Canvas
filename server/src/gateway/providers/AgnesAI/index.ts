import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderDefinition } from "../../contracts.js";
import { gatewayFetch } from "../../transport.js";

const agnesFetch: typeof fetch = (input, init) => {
    if (typeof init?.body !== "string") return gatewayFetch(input, init);
    try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        const effort = body.reasoning_effort;
        if (typeof effort !== "string") return gatewayFetch(input, init);
        const { reasoning_effort: _ignored, ...rest } = body;
        if (effort !== "none") {
            const current = rest.chat_template_kwargs && typeof rest.chat_template_kwargs === "object" ? rest.chat_template_kwargs : {};
            rest.chat_template_kwargs = { ...current, enable_thinking: true };
        }
        return gatewayFetch(input, { ...init, body: JSON.stringify(rest) });
    } catch {
        return gatewayFetch(input, init);
    }
};
import { discoverOpenAICompatibleModels } from "../../discovery.js";
import { agnesImageCapability } from "./image.js";
import { agnesVideoCapability } from "./video.js";

export const agnesProvider = {
    id: "AgnesAI",
    supportsModel: (modelId: string, capability: "image" | "video" | "text" | "audio") =>
        (capability === "text" && ["agnes-2.5-flash", "agnes-3.0-flash"].includes(modelId))
        || (capability === "image" && ["agnes-image-2.1-flash", "agnes-image-2.5-flash"].includes(modelId))
        || (capability === "video" && ["agnes-video-2.5", "agnes-video-2.5-flash"].includes(modelId)),
    discoverModels: discoverOpenAICompatibleModels,
    capabilities: {
        text: {
            model: (binding, apiKey) => createOpenAI({ name: "AgnesAI", baseURL: binding.baseUrl, apiKey, fetch: agnesFetch }).chat(binding.upstreamModel),
            options: ({ reasoningEffort }) => reasoningEffort && reasoningEffort !== "auto" ? { openai: { reasoningEffort } } : {},
        },
        image: agnesImageCapability,
        video: agnesVideoCapability,
    },
} satisfies ProviderDefinition;
