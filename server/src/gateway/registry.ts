import { z } from "zod";
import type { Capability, ImageCapability, ModelBinding, ProviderDefinition, ProviderId, VideoCapability } from "./contracts.js";

export function createRegistry() {
    const providers = new Map<string, ProviderDefinition>();
    const providerIdSchema = z.string().min(1).refine(id => providers.has(id), "未注册的提供商");
    const registerProvider = (definition: ProviderDefinition) => {
        if (!definition.id || providers.has(definition.id)) throw new Error(`提供商 ID 无效或重复：${definition.id}`);
        providers.set(definition.id, definition);
    };
    const provider = (providerId: ProviderId, capability: Capability) => {
        const definition = providers.get(providerId);
        if (!definition) throw new Error(`未注册的提供商：${providerId}`);
        const implementation = definition.capabilities[capability];
        if (!implementation) throw new Error("提供商不支持该模型能力");
        return implementation;
    };
    return {
        providerIdSchema,
        registerProvider,
        capabilities: ["image", "video", "text", "audio"] as const,
        provider: (id: string) => providers.get(id),
        providerForModel(modelId: string, capability: Capability) {
            return [...providers.values()].find(definition => definition.supportsModel?.(modelId, capability))?.id;
        },
        discoverModels: async (baseUrl: string, apiKey: string, providerId: string) => {
            const discover = providers.get(providerId)?.discoverModels;
            if (!discover) throw new Error(`提供商不支持模型发现：${providerId}`);
            return discover(baseUrl, apiKey);
        },
        languageModel(binding: ModelBinding, apiKey: string) {
            if (binding.capability !== "text") throw new Error("调用能力与模型绑定不一致");
            return (provider(binding.providerId, "text") as NonNullable<ProviderDefinition["capabilities"]["text"]>).model(binding, apiKey);
        },
        textOptions(providerId: string, input: { reasoningEffort?: string }) {
            return providers.get(providerId)?.capabilities.text?.options?.(input);
        },
        imageModel(binding: ModelBinding, apiKey: string) {
            if (binding.capability !== "image") throw new Error("调用能力与模型绑定不一致");
            return (provider(binding.providerId, "image") as Extract<ProviderDefinition["capabilities"]["image"], object>).model(binding, apiKey);
        },
        speechModel(binding: ModelBinding, apiKey: string) {
            if (binding.capability !== "audio") throw new Error("调用能力与模型绑定不一致");
            return (provider(binding.providerId, "audio") as Extract<ProviderDefinition["capabilities"]["audio"], object>).model(binding, apiKey);
        },
        videoModel(binding: ModelBinding, apiKey: string) {
            if (binding.capability !== "video") throw new Error("调用能力与模型绑定不一致");
            return (provider(binding.providerId, "video") as Extract<ProviderDefinition["capabilities"]["video"], object>).model(binding, apiKey);
        },
        imageCapability(id: string): ImageCapability { return provider(id, "image") as ImageCapability; },
        videoCapability(id: string): VideoCapability { return provider(id, "video") as VideoCapability; },
        parseVideoOperation(value: unknown) {
            const envelope = z.strictObject({ version: z.literal(2), binding: z.strictObject({ providerId: providerIdSchema, capability: z.literal("video"), upstreamModel: z.string().min(1), baseUrl: z.string().url() }), operation: z.unknown() }).parse(value);
            const implementation = provider(envelope.binding.providerId, "video") as VideoCapability;
            return { ...envelope, operation: implementation.operationSchema.parse(envelope.operation), download: implementation.download };
        },
        videoDownloader(id: string) { return (provider(id, "video") as VideoCapability).download; },
        assertProviderCapability(id: string, capability: Capability) { provider(id, capability); },
    };
}
