import assert from "node:assert/strict";
import { test } from "node:test";

import { createModelsDevLoader, findModelSpec } from "../src/catalog/models-dev.js";

const entry = { name: "Example Chat", family: "example", limit: { context: 128000, input: 120000, output: 8000 }, tool_call: true, reasoning: false, structured_output: true, modalities: { input: ["text", "image"], output: ["text"] } };
const response = (data: unknown) => Response.json(data);

test("matches canonical IDs and unique exact model IDs without guessing aliases", async () => {
    const load = createModelsDevLoader(async () => response({ "lab/chat": entry, "other/chat": entry, "lab/unique": entry }));
    const specs = await load();
    assert.equal(findModelSpec(specs, "lab/chat")?.canonicalId, "lab/chat");
    assert.equal(findModelSpec(specs, "chat", "lab")?.canonicalId, "lab/chat");
    assert.equal(findModelSpec(specs, "unique")?.canonicalId, "lab/unique");
    assert.equal(findModelSpec(specs, "chat"), undefined);
    assert.equal(findModelSpec(specs, "chat-latest", "lab"), undefined);
    assert.equal(findModelSpec(specs, "other/unique"), undefined);
});

test("preserves token limits and false flags, strips unknown fields and skips malformed entries", async () => {
    const load = createModelsDevLoader(async () => response({
        "lab/chat": { ...entry, apiKey: "must-not-leak", last_updated: "2026-09-22" },
        "lab/broken": { ...entry, limit: { context: -1, output: 8000 } },
        "lab/malformed": { ...entry, tool_call: "yes" },
        "lab/image": { ...entry, limit: { context: 0, output: 0 } },
    }));
    const specs = await load();
    const spec = findModelSpec(specs, "chat");
    assert.equal(spec?.source, "models.dev");
    assert.deepEqual(spec?.limit, entry.limit);
    assert.equal(spec?.reasoning, false);
    assert.deepEqual(spec?.modalities, entry.modalities);
    assert.equal(spec?.lastUpdated, "2026-09-22");
    assert.equal(JSON.stringify(spec).includes("must-not-leak"), false);
    assert.equal(findModelSpec(specs, "broken"), undefined);
    assert.equal(findModelSpec(specs, "malformed"), undefined);
    assert.equal(findModelSpec(specs, "image")?.limit.context, 0);
});

test("shares in-flight requests and caches public data without sending account credentials", async () => {
    let calls = 0;
    let now = 0;
    const load = createModelsDevLoader(async (url, init) => {
        calls++;
        assert.equal(url, "https://models.dev/models.json");
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        return response({ "lab/chat": entry });
    }, () => now);
    await Promise.all([load(), load(), load()]);
    assert.equal(calls, 1);
    await load();
    assert.equal(calls, 1);
    now = 3600001;
    await load();
    assert.equal(calls, 2);
});

test("metadata outages and malformed roots return no specs with a short retry cooldown", async () => {
    for (const fetcher of [
        async () => { throw new Error("network unavailable"); },
        async () => new Response(null, { status: 503 }),
        async () => new Response("not json"),
        async () => response([]),
    ]) {
        let calls = 0;
        let now = 0;
        const load = createModelsDevLoader(async () => { calls++; return fetcher(); }, () => now);
        assert.equal((await load()).size, 0);
        await load();
        assert.equal(calls, 1);
        now = 60001;
        await load();
        assert.equal(calls, 2);
    }
});
