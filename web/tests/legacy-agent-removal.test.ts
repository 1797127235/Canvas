import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { buildNodeMentionReferences, getGroupResourceNodes } from "../src/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

test("legacy Agent implementation is removed instead of kept as an unused shell", () => {
    for (const path of [
        "components/agent",
        "stores/use-agent-store.ts",
        "stores/use-workbench-agent-store.ts",
        "pages/canvas/hooks/use-agent-bridge.ts",
        "lib/canvas/canvas-ops.ts",
    ]) {
        expect(existsSync(new URL(`../src/${path}`, import.meta.url))).toBe(false);
    }
});

test("page entrypoints do not mount or dispatch to the old Agent", () => {
    for (const path of [
        "layouts/user-layout.tsx",
        "components/layout/app-top-nav.tsx",
        "components/canvas/canvas-top-bar.tsx",
        "pages/canvas/project.tsx",
        "pages/image/index.tsx",
        "pages/video/index.tsx",
    ]) {
        const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
        expect(source).not.toMatch(/useAgentStore|useWorkbenchAgentStore|useAgentBridge|AgentPanel|agentTaskId|autoRunToken|onToggleAgent/);
    }
});

test("ordinary canvas prompts still resolve grouped media and text references", () => {
    const node = (id: string, type: CanvasNodeData["type"], metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
        id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata,
    });
    const nodes = [
        node("group", CanvasNodeType.Group),
        node("image", CanvasNodeType.Image, { groupId: "group", content: "/api/media/image" }),
        node("video", CanvasNodeType.Video, { groupId: "group", content: "/api/media/video" }),
        node("audio", CanvasNodeType.Audio, { groupId: "group", content: "/api/media/audio" }),
        node("text", CanvasNodeType.Text, { groupId: "group", content: "参考文案" }),
        node("unrelated", CanvasNodeType.Image, { content: "/api/media/other" }),
        node("config", CanvasNodeType.Config),
    ];
    const references = buildNodeMentionReferences(nodes.at(-1)!, nodes, [{ id: "input", fromNodeId: "group", toNodeId: "config" }]);
    expect(references.map(reference => reference.kind)).toEqual(["image", "video", "audio", "text"]);
    expect(references.map(reference => reference.nodeId)).toEqual(["image", "video", "audio", "text"]);
    expect(references.at(-1)?.text).toBe("参考文案");
    expect(getGroupResourceNodes("group", nodes)).toHaveLength(4);
});
