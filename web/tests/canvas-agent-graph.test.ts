import { beforeAll, expect, test } from "bun:test";

import { buildAssetsContext, buildCanvasContext } from "../src/lib/canvas/canvas-agent-context";
import { applyGraphInput, buildAgentGraph } from "../src/lib/canvas/canvas-agent-graph";
import { registerNodeDefinitions } from "../src/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";

// 只注册测试需要的节点类型：不引入 builtin-nodes，避免把整棵 React 组件树拉进单测。
beforeAll(() => {
    registerNodeDefinitions([
        { type: CanvasNodeType.Text, title: "文本", icon: null, defaultSize: { width: 340, height: 240 }, defaultMetadata: { content: "", status: "idle" } },
        { type: CanvasNodeType.Image, title: "图片", icon: null, defaultSize: { width: 340, height: 240 }, defaultMetadata: {} },
        { type: CanvasNodeType.Video, title: "视频", icon: null, defaultSize: { width: 420, height: 236 }, defaultMetadata: {} },
    ]);
});

const origin = { x: 0, y: 0 };

test("lays new nodes out left to right without overlapping", () => {
    const result = buildAgentGraph(applyGraphInput.parse({ nodes: [{ key: "a", type: "text", content: "夕阳" }, { key: "b", type: "image" }] }), [], origin);
    expect(result.nodes).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    const [first, second] = result.nodes;
    expect(first.position.x + first.width).toBeLessThanOrEqual(second.position.x);
    // 坐标由代码算：同一批节点垂直居中对齐到视口中心。
    expect(first.position.y + first.height / 2).toBeCloseTo(origin.y);
    expect(second.position.y + second.height / 2).toBeCloseTo(origin.y);
});

test("starts a new row to the right of existing canvas content", () => {
    const existing: CanvasNodeData[] = [{ id: "old", type: CanvasNodeType.Image, title: "旧图", position: { x: 100, y: 0 }, width: 340, height: 240 }];
    const result = buildAgentGraph(applyGraphInput.parse({ nodes: [{ key: "a", type: "text" }] }), existing, origin);
    expect(result.nodes[0].position.x).toBeGreaterThanOrEqual(440);
});

test("maps connection keys to real node ids and rejects dangling or self links", () => {
    const result = buildAgentGraph(
        applyGraphInput.parse({
            nodes: [{ key: "text", type: "text", content: "提示词" }, { key: "image", type: "image" }],
            connections: [{ from: "text", to: "image" }, { from: "text", to: "missing" }, { from: "image", to: "image" }],
        }),
        [],
        origin,
    );
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].fromNodeId).toBe(result.created[0].nodeId);
    expect(result.connections[0].toNodeId).toBe(result.created[1].nodeId);
    expect(result.warnings).toHaveLength(2);
});

test("skips unknown node types instead of failing the whole batch", () => {
    const result = buildAgentGraph(applyGraphInput.parse({ nodes: [{ key: "a", type: "plugin-node" }, { key: "b", type: "text" }] }), [], origin);
    expect(result.nodes).toHaveLength(1);
    expect(result.created.map((item) => item.key)).toEqual(["b"]);
    expect(result.warnings[0]).toContain("plugin-node");
});

test("turns a remote storage key into a servable media url", () => {
    const mediaId = "6f1b0e2c-1111-4c2a-9d3e-1a2b3c4d5e6f";
    const result = buildAgentGraph(applyGraphInput.parse({ nodes: [{ key: "a", type: "image", storageKey: `remote:${mediaId}` }] }), [], origin);
    expect(result.nodes[0].metadata?.storageKey).toBe(`remote:${mediaId}`);
    expect(result.nodes[0].metadata?.content).toBe(`/api/media/${mediaId}`);
    expect(result.nodes[0].metadata?.status).toBe("success");
});

test("rejects malformed tool input before it reaches the canvas", () => {
    expect(applyGraphInput.safeParse({ nodes: [] }).success).toBe(false);
    expect(applyGraphInput.safeParse({ nodes: [{ key: "a", type: "text", position: { x: 0, y: 0 } }] }).success).toBe(false);
    expect(applyGraphInput.safeParse({ nodes: Array.from({ length: 21 }, (_, index) => ({ key: `n${index}`, type: "text" })) }).success).toBe(false);
});

test("summarizes the canvas without leaking content bodies", () => {
    const nodes: CanvasNodeData[] = [
        {
            id: "image-1",
            type: CanvasNodeType.Image,
            title: "参考图",
            position: { x: 10, y: 20 },
            width: 340,
            height: 240,
            metadata: { content: "/api/media/abc", storageKey: "remote:abc", status: "success", prompt: "x".repeat(400) },
        },
    ];
    const context = buildCanvasContext(nodes, [{ id: "c1", fromNodeId: "image-1", toNodeId: "image-1" }], new Set(["image-1"]));
    const serialized = JSON.stringify(context.value);
    expect(serialized).not.toContain("data:image");
    expect(serialized.length).toBeLessThan(600);
    const summary = context.value.nodes as Array<Record<string, unknown>>;
    expect(summary[0].hasMedia).toBe(true);
    expect(String(summary[0].prompt)).toHaveLength(121);
    expect(String(summary[0].prompt).endsWith("…")).toBe(true);
    expect(context.value.selectedNodeIds).toEqual(["image-1"]);
});

test("caps the asset summary and omits text asset keys", () => {
    const assets = Array.from({ length: 60 }, (_, index) => ({ id: `a${index}`, kind: index === 0 ? ("text" as const) : ("image" as const), title: `资产 ${index}`, tags: [], coverUrl: "", data: index === 0 ? { content: "文本" } : { dataUrl: "/api/media/x", storageKey: `remote:x${index}`, width: 10, height: 10, bytes: 1, mimeType: "image/png" } }));
    const context = buildAssetsContext(assets);
    const summary = context.value.assets as Array<Record<string, unknown>>;
    expect(summary).toHaveLength(40);
    expect(summary[0].storageKey).toBeNull();
    expect(context.value.total).toBe(60);
});
