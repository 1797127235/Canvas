import { afterEach, expect, test } from "bun:test";
import { fetchServerModels } from "../src/services/api/catalog";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const spec = { canonicalId: "lab/chat", name: "Example Chat", limit: { context: 128000, input: 120000, output: 8000 }, toolCall: true, reasoning: false, structuredOutput: true, modalities: { input: ["text", "image"], output: ["text"] }, source: "models.dev" };

test("preserves validated model identity and token limits from the catalog API", async () => {
    globalThis.fetch = (async () => Response.json({ models: [{ id: "chat", name: "Chat", capability: "text", spec }] })) as typeof fetch;
    expect(await fetchServerModels()).toEqual([{ id: "chat", name: "Chat", capability: "text", spec }]);
});

test("unknown models remain usable without supplemental specs", async () => {
    const models = [{ id: "unknown", name: "Unknown", capability: "text" }];
    globalThis.fetch = (async () => Response.json({ models })) as typeof fetch;
    expect(await fetchServerModels()).toEqual(models);
});

test("rejects malformed supplemental token limits", async () => {
    globalThis.fetch = (async () => Response.json({ models: [{ id: "chat", name: "Chat", capability: "text", spec: { ...spec, limit: { context: -1, output: 8000 } } }] })) as typeof fetch;
    await expect(fetchServerModels()).rejects.toThrow();
});
