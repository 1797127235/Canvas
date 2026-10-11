import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { loadCatalog, publicModels, resolveModel } from "../src/catalog/catalog.js";

const directory = await mkdtemp(join(tmpdir(), "catalog-test-"));
const write = async (name: string, content: unknown) => {
    const path = join(directory, name);
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
};
const model = (overrides: Record<string, unknown> = {}) => ({
    id: "image", name: "Image", upstreamModel: "gpt-image-2.5", adapter: "openai-images",
    capability: "image", enabled: true, baseUrl: "https://api.example.com/v1", apiKey: "key", ...overrides,
});

after(() => rm(directory, { recursive: true, force: true }));

test("returns an empty catalog when no path is configured", async () => {
    assert.deepEqual(await loadCatalog(), { models: [] });
});

test("trims surrounding whitespace from base URLs and keys", async () => {
    const path = await write("trim.json", { models: [model({ baseUrl: "  https://api.example.com/v1  ", apiKey: "  key  " })] });
    const catalog = await loadCatalog(path);
    assert.equal(catalog.models[0].baseUrl, "https://api.example.com/v1");
    assert.equal(catalog.models[0].apiKey, "key");
});

test("keeps a blank key invalid instead of silently accepting it", async () => {
    for (const apiKey of ["", "   "]) {
        const path = await write("blank.json", { models: [model({ apiKey })] });
        await assert.rejects(loadCatalog(path), /Invalid catalog configuration/);
    }
});

test("rejects an adapter that does not serve its declared capability", async () => {
    const path = await write("mismatch.json", { models: [model({ adapter: "minimax-videos" })] });
    await assert.rejects(loadCatalog(path), /Invalid catalog configuration/);
});

test("rejects duplicate ids, unknown fields, unknown adapters and malformed JSON", async () => {
    const cases = [
        { models: [model(), model({ name: "Other" })] },
        { models: [model({ script: "x" })] },
        { models: [model({ adapter: "custom" })] },
        { upstream: { baseUrl: "https://api.example.com/v1" }, models: [] },
    ];
    for (const [index, content] of cases.entries()) {
        await assert.rejects(loadCatalog(await write(`invalid-${index}.json`, content)), /Invalid catalog configuration/);
    }
    await assert.rejects(loadCatalog(await write("broken.json", "{ not json")), /Invalid catalog configuration/);
});

test("requires HTTPS only in production", async () => {
    const path = await write("http.json", { models: [model({ baseUrl: "http://127.0.0.1:8000/v1" })] });
    assert.equal((await loadCatalog(path)).models.length, 1);
    await assert.rejects(loadCatalog(path, true), /Invalid catalog configuration/);
});

test("publishes only enabled model metadata", async () => {
    const path = await write("public.json", { models: [model(), model({ id: "hidden", enabled: false })] });
    const catalog = await loadCatalog(path);
    assert.deepEqual(publicModels(catalog), [{ id: "image", name: "Image", capability: "image" }]);
    assert.equal(resolveModel(catalog, "hidden", "image"), null);
    assert.equal(resolveModel(catalog, "image", "video"), null);
    assert.equal(resolveModel(catalog, "image", "image")?.apiKey, "key");
});
