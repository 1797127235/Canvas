import { expect, test } from "bun:test";

import { resetInterruptedGeneration } from "../src/lib/canvas/canvas-generation-helpers";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../src/types/canvas";

const node = (id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData =>
    ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata }) as CanvasNodeData;

const edge = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });

const INTERRUPTED = "页面刷新后生成已中断，请重新生成。";

test("刷新恢复：带任务号的 loading 节点保持 loading，不带任务号的判为中断", () => {
    const nodes = [
        node("by-node", CanvasNodeType.Image, { status: "loading", generationTaskId: "task-1" }),
        node("by-slot", CanvasNodeType.Image, { status: "loading", images: [{ id: "a", status: "loading", taskId: "task-2" }] }),
        node("orphan", CanvasNodeType.Image, { status: "loading" }),
    ];
    const result = resetInterruptedGeneration(nodes);
    expect(result[0].metadata?.status).toBe("loading");
    expect(result[1].metadata?.status).toBe("loading");
    expect(result[2].metadata?.status).toBe("error");
    expect(result[2].metadata?.errorDetails).toBe(INTERRUPTED);
});

test("刷新恢复：槽位有任务号时不把该槽位判为中断", () => {
    const [kept, killed] = resetInterruptedGeneration([
        node("n", CanvasNodeType.Image, { status: "loading", images: [{ id: "a", status: "loading", taskId: "t" }] }),
        node("m", CanvasNodeType.Image, { status: "loading", images: [{ id: "a", status: "loading" }] }),
    ]);
    expect(kept.metadata?.status).toBe("loading");
    expect(kept.metadata?.images?.[0].status).toBe("loading");
    expect(killed.metadata?.status).toBe("error");
    expect(killed.metadata?.images?.[0].status).toBe("error");
});

test("刷新恢复：批量生图的源配置节点随下游可恢复任务一起保留，下游不可恢复时判为中断", () => {
    const nodes = [
        node("config-resumable", CanvasNodeType.Config, { status: "loading" }),
        node("image-resumable", CanvasNodeType.Image, { status: "loading", generationTaskId: "task-1" }),
        node("config-orphan", CanvasNodeType.Config, { status: "loading" }),
        node("image-orphan", CanvasNodeType.Image, { status: "loading" }),
    ];
    const connections = [edge("config-resumable", "image-resumable"), edge("config-orphan", "image-orphan")];
    const result = resetInterruptedGeneration(nodes, connections);
    expect(result[0].metadata?.status).toBe("loading");
    expect(result[1].metadata?.status).toBe("loading");
    expect(result[2].metadata?.status).toBe("error");
    expect(result[3].metadata?.status).toBe("error");
});

test("刷新恢复：未在生成的节点不受影响", () => {
    const nodes = [node("done", CanvasNodeType.Image, { status: "success" }), node("idle", CanvasNodeType.Text, { status: "idle" })];
    const result = resetInterruptedGeneration(nodes);
    expect(result.map((item) => item.metadata?.status)).toEqual(["success", "idle"]);
});
