import { createRegistry } from "./registry.js";
import type { Capability, ModelBinding } from "./contracts.js";

// Provider packages are composed in providers.ts. The base runtime intentionally ships no provider.
export const gateway = createRegistry();
export const chatModel = (binding: ModelBinding, apiKey: string) => gateway.languageModel(binding, apiKey);
export const textProviderOptions = gateway.textOptions;
export const imageModel = (binding: ModelBinding, apiKey: string) => gateway.imageModel(binding, apiKey);
export const speechModel = (binding: ModelBinding, apiKey: string) => gateway.speechModel(binding, apiKey);
export const videoModel = (binding: ModelBinding, apiKey: string) => gateway.videoModel(binding, apiKey);
export const imageCapability = gateway.imageCapability;
export const videoCapability = gateway.videoCapability;
export const parseVideoOperation = gateway.parseVideoOperation;
export const videoDownloader = gateway.videoDownloader;
export const providerCapability = (providerId: string, capability: Capability) => gateway.assertProviderCapability(providerId, capability);
export const discoverModels = gateway.discoverModels;
