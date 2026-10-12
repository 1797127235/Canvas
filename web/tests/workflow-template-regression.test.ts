import { afterEach, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

mock.module("@/lib/auth-access", () => ({ bypassLocalAuth: false, canAccessLocalFeatures: (status: string) => status === "authenticated" }));

import { generationOutputNode, nodeGenerationPrompt, findRetrySourceNode } from "../src/lib/canvas/canvas-generation-helpers";
import { buildNodeGenerationContext } from "../src/components/canvas/canvas-node-generation";
import { cloneWorkflowTemplate, type WorkflowTemplate } from "../src/services/api/templates";
import { useUserStore } from "../src/stores/use-user-store";
import { useWorkspaceStore } from "../src/stores/use-workspace-store";
import { useCanvasStore } from "../src/stores/canvas/use-canvas-store";
import type { CanvasGenerationMode } from "../src/types/canvas";

const templates = JSON.parse(readFileSync(new URL("../public/templates/templates.json", import.meta.url), "utf8")) as WorkflowTemplate[];
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalUser = useUserStore.getState();
const originalWorkspace = useWorkspaceStore.getState();
const originalProjects = useCanvasStore.getState().projects;

afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    useUserStore.setState(originalUser);
    useWorkspaceStore.setState(originalWorkspace);
    useCanvasStore.setState({ projects: originalProjects });
});

test("template outputs keep downstream references when their media is regenerated", () => {
    const template = structuredClone(templates.find(item => item.id === "outfit-change-video")!);
    const { nodes, connections } = template.project;
    const imageConfigs = nodes.filter(node => node.type === "config" && node.metadata?.generationMode === "image");
    expect(imageConfigs).toHaveLength(6);
    const videoConfig = nodes.find(node => node.type === "config" && node.metadata?.generationMode === "video")!;
    const initialContext = buildNodeGenerationContext(videoConfig.id, nodes, connections, nodeGenerationPrompt(videoConfig));
    for (const [index, config] of imageConfigs.entries()) {
        const output = generationOutputNode(config, "image", nodes, connections)!;
        expect(output).toBeDefined();
        if (index > 0) {
            const input = buildNodeGenerationContext(config.id, nodes, connections, nodeGenerationPrompt(config));
            expect(input.referenceImages[0].storageKey).toBe("remote:new-0");
        }
        output.metadata = { ...output.metadata, storageKey: `remote:new-${index}`, content: `/api/media/new-${index}` };
    }
    const context = buildNodeGenerationContext(videoConfig.id, nodes, connections, nodeGenerationPrompt(videoConfig));
    expect(context.referenceImages.map(image => image.id)).toEqual(initialContext.referenceImages.map(image => image.id));
    expect(context.referenceImages.map(image => image.storageKey)).toEqual([1, 2, 3, 4, 5].map(index => `remote:new-${index}`));
    expect(context.videoCount).toBe(1);
    expect(nodes).toHaveLength(24);
    expect(connections).toHaveLength(26);
});

test("video result retry resolves current references and edited text from its config", () => {
    for (const template of templates.filter(item => ["outfit-change-video", "talking-product-ad"].includes(item.id))) {
        const { nodes, connections } = structuredClone(template.project);
        const config = nodes.find(node => node.type === "config" && node.metadata?.generationMode === "video")!;
        const output = generationOutputNode(config, "video", nodes, connections)!;
        const source = findRetrySourceNode(output.id, nodes, connections)!;
        expect(source.id).toBe(config.id);
        const copy = nodes.find(node => node.id === (template.id === "talking-product-ad" ? "talking-ad-copy" : "outfit-video-script"))!;
        copy.metadata = { ...copy.metadata, content: "修改后的回归文案" };
        const context = buildNodeGenerationContext(source.id, nodes, connections, nodeGenerationPrompt(source));
        expect(context.imageCount).toBe(template.id === "talking-product-ad" ? 3 : 5);
        expect(context.videoCount).toBe(template.id === "talking-product-ad" ? 0 : 1);
        expect(context.prompt).toContain("修改后的回归文案");
        expect(context.prompt).not.toContain("@[node:");
    }
});

test("fixed outputs are explicit and a deleted output is rejected rather than replaced silently", () => {
    for (const template of templates.filter(item => item.id !== "cat-dance")) {
        const { nodes, connections } = template.project;
        for (const config of nodes.filter(node => node.type === "config")) {
            const mode = config.metadata!.generationMode as CanvasGenerationMode;
            expect(generationOutputNode(config, mode, nodes, connections)?.id).toBe(config.metadata!.outputNodeId);
            expect(() => generationOutputNode(config, mode, nodes.filter(node => node.id !== config.metadata!.outputNodeId), connections)).toThrow("模板输出节点缺失");
        }
    }
    const plainConfig = { ...templates[1].project.nodes.find(node => node.type === "config")!, metadata: { generationMode: "image" as const } };
    expect(generationOutputNode(plainConfig, "image", [], [])).toBeUndefined();
});

test("account change while downloading a template cancels before uploading to the new account", async () => {
    globalThis.window = { location: { origin: "http://localhost:3000" } } as Window & typeof globalThis;
    useUserStore.setState({ status: "authenticated", user: { id: "account-a", email: "a@example.test" } });
    useWorkspaceStore.setState({ owner: "account-a", status: "ready" });
    let finish!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    let calls = 0;
    globalThis.fetch = ((_, init) => {
        calls++;
        signal = init?.signal as AbortSignal;
        return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch;
    const pending = cloneWorkflowTemplate(templates.find(item => item.id === "talking-product-ad")!);
    const result = pending.catch(error => error as Error);
    useUserStore.setState({ user: { id: "account-b", email: "b@example.test" } });
    expect(signal?.aborted).toBe(true);
    finish(new Response(new Blob(["placeholder"], { type: "image/png" })));
    expect((await result as Error).message).toContain("账号已切换");
    expect(calls).toBe(1);
    expect(useCanvasStore.getState().projects).toEqual(originalProjects);
});
