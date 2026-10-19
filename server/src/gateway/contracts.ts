import type { Experimental_VideoModelV4, ImageModelV4, LanguageModelV4, SpeechModelV4 } from "@ai-sdk/provider";
import type { ZodType } from "zod";

export const capabilities = ["image", "video", "text", "audio"] as const;
export type Capability = typeof capabilities[number];
export type ProviderId = string;
export type ModelBinding = { providerId: ProviderId; capability: Capability; upstreamModel: string; baseUrl: string };

export type DiscoveredModel = { id: string; capability?: unknown; capabilities?: unknown; owned_by?: string };
export type ImageCapability = {
    model(binding: ModelBinding, apiKey: string): ImageModelV4;
    options?(input: { size?: string; quality?: string; background?: string; outputFormat?: string }): Record<string, unknown>;
    aspectRatios?: readonly `${number}:${number}`[];
};
export type VideoCapability = {
    model(binding: ModelBinding, apiKey: string): Experimental_VideoModelV4;
    download(url: string, binding: ModelBinding, apiKey: string, signal: AbortSignal): Promise<import("node:stream").Readable>;
    operationSchema: ZodType;
    options?(input: { resolution?: string; watermark?: boolean; size?: string; imageUrls?: string[] }): Record<string, unknown>;
    aspectRatios?: readonly `${number}:${number}`[];
    validateInput?(input: { videos?: string[]; audios?: string[]; generateAudio?: boolean; frameCount?: number; unsupportedReferences?: string[] }): void;
};
export type ProviderCapabilities = {
    text?: {
        model(binding: ModelBinding, apiKey: string): LanguageModelV4;
        options?(input: { reasoningEffort?: string }): Record<string, unknown>;
    };
    image?: ImageCapability;
    audio?: { model(binding: ModelBinding, apiKey: string): SpeechModelV4 };
    video?: VideoCapability;
};
export type ProviderDefinition = {
    id: string;
    discoverModels: (baseUrl: string, apiKey: string) => Promise<DiscoveredModel[]>;
    capabilities: ProviderCapabilities;
};
