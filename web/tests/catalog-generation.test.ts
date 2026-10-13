import { afterEach, expect, mock, test } from "bun:test";

mock.module("@/lib/auth-access", () => ({ bypassLocalAuth: false, canAccessLocalFeatures: (status: string) => status === "authenticated" }));

import { useCatalogStore, catalogModel } from "../src/stores/use-catalog-store";
import { defaultConfig, resolveModelForCapability } from "../src/stores/use-config-store";
import { buildGenerationConfig } from "../src/lib/canvas/canvas-generation-helpers";
import { requestGeneration, requestEdit, requestImageQuestion } from "../src/services/api/image";
import { requestAudioGeneration } from "../src/services/api/audio";
import { createVideoGenerationTask, pollVideoGenerationTask } from "../src/services/api/video";
import { CanvasNodeType } from "../src/types/canvas";

test("text streams and speech use the account endpoint without local credentials", async () => {
    useCatalogStore.setState({ status: "ready", models: [
        { id: "chat", name: "Chat", capability: "text" }, { id: "speech", name: "Speech", capability: "audio" },
    ] });
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url, init) => {
        expect(String(url)).toBe("/api/generations");
        const body = JSON.parse(String(init?.body));
        sent.push(body);
        if (body.capability === "audio") return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
        return new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const updates: string[] = [];
    expect(await requestImageQuestion({ ...obsoleteConfig, model: "chat" }, [{ role: "user", content: "hello" }], text => updates.push(text))).toBe("你好");
    expect(updates.at(-1)).toBe("你好");
    const audio = await requestAudioGeneration({ ...obsoleteConfig, model: "speech" }, "hello");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(JSON.stringify(sent)).not.toContain("old-local-key");
    expect(JSON.stringify(sent)).not.toContain("old.invalid");
});

test("catalog reset rejects a late response from a previous key", async () => {
    let finish!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
    const pending = useCatalogStore.getState().load();
    useCatalogStore.getState().reset();
    finish(json({ models }));
    await pending;
    expect(useCatalogStore.getState().models).toEqual([]);
    expect(useCatalogStore.getState().status).toBe("idle");
});

const originalFetch = globalThis.fetch;
const models = [
    { id: "openai-image-2-5", name: "GPT Image 2.5", capability: "image" as const },
    { id: "doubao-seedance-2-0-mini", name: "doubao-seedance-2-0-mini", capability: "video" as const },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const obsoleteConfig = { ...defaultConfig, model: "old::grok-image", imageModel: "old::grok-image", videoModel: "old::doubao", apiKey: "old-local-key", baseUrl: "https://old.invalid" };

afterEach(() => { globalThis.fetch = originalFetch; useCatalogStore.getState().reset(); });

test("loads one catalog for concurrent consumers, with no stale fallback after failure", async () => {
    let complete!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (() => { calls++; return new Promise<Response>(resolve => { complete = resolve; }); }) as typeof fetch;
    const first = useCatalogStore.getState().load();
    const second = useCatalogStore.getState().load();
    complete(json({ models }));
    await Promise.all([first, second]);
    await useCatalogStore.getState().load();
    expect(calls).toBe(1);
    expect(catalogModel("image", obsoleteConfig.imageModel)?.id).toBe(models[0].id);
    expect(catalogModel("text")).toBeUndefined();
    useCatalogStore.setState({ status: "idle" });
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await useCatalogStore.getState().load();
    expect(useCatalogStore.getState().status).toBe("error");
    expect(catalogModel("image")).toBeUndefined();
});

test("canvas and workbench send the same server image model without local keys or host", async () => {
    useCatalogStore.setState({ models, status: "ready" });
    const sent: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = [];
    globalThis.fetch = (async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
        return json({ data: [{ b64_json: "aGVsbG8=", mime_type: "image/jpeg" }] });
    }) as typeof fetch;
    const node = { id: "node", type: CanvasNodeType.Image, title: "", width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { model: obsoleteConfig.imageModel } };
    const canvasConfig = buildGenerationConfig(obsoleteConfig, node, "image");
    expect(canvasConfig.model).toBe(models[0].id);
    const signal = new AbortController().signal;
    const first = await requestGeneration({ ...obsoleteConfig, count: "1" }, "workbench", { signal });
    const second = await requestGeneration({ ...canvasConfig, count: "1" }, "canvas", { signal });
    await requestEdit(canvasConfig, "edit", [{ id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,aGVsbG8=" }], { signal });
    expect(sent.map(item => item.url)).toEqual(["/api/generations", "/api/generations", "/api/generations"]);
    expect(sent.every(item => item.body.modelId === models[0].id && item.signal === signal)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("old-local-key");
    expect(JSON.stringify(sent)).not.toContain("old.invalid");
    expect(first[0].id).not.toBe(second[0].id);
    expect(first[0].dataUrl).toBe("data:image/jpeg;base64,aGVsbG8=");
    expect((sent[2].body.input as Record<string, unknown>).images).toEqual(["data:image/png;base64,aGVsbG8="]);
    expect(resolveModelForCapability(obsoleteConfig, "old-text", "text")).toBe("");
    await requestGeneration({ ...obsoleteConfig, count: "1", quality: "1k", size: "1:1" }, "preset");
    expect((sent.at(-1)?.body.input as Record<string, unknown>).size).toBe("1024x1024");
});

test("canvas and workbench use one video create/poll path and preserve binary bytes", async () => {
    useCatalogStore.setState({ models, status: "ready" });
    const sent: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const bytes = new Uint8Array([0, 255, 128, 1, 42]);
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        sent.push({ url: path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (init?.method === "POST") return json({ id: "12345678-1234-4234-8234-123456789012" });
        if (path.endsWith("/content")) return new Response(bytes, { headers: { "content-type": "video/mp4" } });
        return json({ status: "completed" });
    }) as typeof fetch;
    const config = { ...obsoleteConfig, model: "old::doubao", size: "auto" };
    const one = await createVideoGenerationTask(config, "workbench");
    const two = await createVideoGenerationTask(buildGenerationConfig(config, undefined, "video"), "canvas");
    expect(one.model).toBe(models[1].id);
    expect(two.model).toBe(models[1].id);
    const state = await pollVideoGenerationTask(config, one);
    expect(state.status).toBe("completed");
    if (state.status !== "completed" || !state.result.blob) throw new Error("Missing video result");
    expect(new Uint8Array(await state.result.blob.arrayBuffer())).toEqual(bytes);
    expect(sent.filter(item => item.body).every(item => item.body?.modelId === models[1].id)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("old-local-key");
});
