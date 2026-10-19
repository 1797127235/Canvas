import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistry } from "../src/gateway/registry.js";

const operationSchema = (await import("zod")).z.strictObject({ task: (await import("zod")).z.string() });

test("a provider package registers once and supplies discovery, capability and task restoration", async () => {
    const registry = createRegistry();
    let calls = 0;
    const model = { specificationVersion: "v4", provider: "test.text", modelId: "opaque", doGenerate: async () => ({ content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } }, warnings: [], response: { id: "test" } }) } as never;
    registry.registerProvider({
        id: "test-provider",
        discoverModels: async () => [{ id: "opaque", capability: "text" }],
        capabilities: {
            text: { model: () => { calls++; return model; } },
            video: {
                model: () => ({ specificationVersion: "v4", provider: "test.video", modelId: "opaque", doStart: async () => ({ operation: { task: "123" }, warnings: [], response: { timestamp: new Date(), modelId: "opaque" } }), doStatus: async () => ({ status: "pending", response: { timestamp: new Date(), modelId: "opaque" } }) }) as never,
                operationSchema,
                download: async () => { throw new Error("not used"); },
            },
        },
    });
    assert.deepEqual(await registry.discoverModels("https://provider.example/v1", "key", "test-provider"), [{ id: "opaque", capability: "text" }]);
    assert.equal(registry.languageModel({ providerId: "test-provider", capability: "text", upstreamModel: "opaque", baseUrl: "https://provider.example/v1" }, "key"), model);
    assert.equal(calls, 1);
    const restored = registry.parseVideoOperation({ version: 2, binding: { providerId: "test-provider", capability: "video", upstreamModel: "opaque", baseUrl: "https://provider.example/v1" }, operation: { task: "123" } });
    assert.deepEqual(restored.operation, { task: "123" });
    assert.throws(() => registry.parseVideoOperation({ version: 2, binding: { providerId: "test-provider", capability: "video", upstreamModel: "opaque", baseUrl: "https://provider.example/v1" }, operation: { unknown: true } }));
    assert.throws(() => registry.registerProvider({ id: "test-provider", discoverModels: async () => [], capabilities: {} }), /重复/);
});
