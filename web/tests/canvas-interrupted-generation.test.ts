import { expect, test } from "bun:test";

import { resetInterruptedGeneration, hasResumableVideoTask, hasVideoTaskId } from "../src/lib/canvas/canvas-generation-helpers";
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

// 视频节点建任务被上游拒绝时曾被预写进一个服务端没落库的「幽灵任务号」，
// 且旧判定不看状态，失败节点被无限当可恢复任务轮询（显示一个不存在的任务 ID）。
test("视频恢复：只有 loading 状态才当作可恢复任务", () => {
    expect(hasResumableVideoTask(node("loading", CanvasNodeType.Video, { status: "loading", videoTaskId: "t" }))).toBe(true);
    expect(hasResumableVideoTask(node("error", CanvasNodeType.Video, { status: "error", videoTaskId: "幽灵号" }))).toBe(false);
    expect(hasResumableVideoTask(node("success", CanvasNodeType.Video, { status: "success" }))).toBe(false);
    expect(hasResumableVideoTask(node("hasContent", CanvasNodeType.Video, { status: "loading", videoTaskId: "t", content: "v.mp4" }))).toBe(false);
    expect(hasResumableVideoTask(node("image", CanvasNodeType.Image, { status: "loading", videoTaskId: "t" }))).toBe(false);
});

test("视频恢复：失败的视频节点不因残留任务号被判为可恢复，也不受刷新中断影响", () => {
    const leftovers = resetInterruptedGeneration([
        node("video-error", CanvasNodeType.Video, { status: "error", videoTaskId: "幽灵号", errorDetails: "上游视频生成失败" }),
        node("video-running", CanvasNodeType.Video, { status: "loading", videoTaskId: "真号" }),
    ]);
    // error 节点既不该被交给恢复轮询，也不该被改写错误文案（它已经带着真实的上游错误）。
    expect(hasResumableVideoTask(leftovers[0])).toBe(false);
    expect(leftovers[0].metadata?.errorDetails).toBe("上游视频生成失败");
    expect(hasResumableVideoTask(leftovers[1])).toBe(true);
});

// 手动「查询任务」与自动恢复是两个语义：工具栏在「有任务号且非 loading」时显示查询按钮，
// 所以查询必须按 hasVideoTaskId 判断，否则点查询会掉进普通重试、另建一个新任务。
test("视频查询：非 loading 但带任务号的节点可查询，但不可自动恢复", () => {
    const failed = node("failed", CanvasNodeType.Video, { status: "error", videoTaskId: "t", errorDetails: "上游视频生成失败" });
    expect(hasVideoTaskId(failed)).toBe(true);
    expect(hasResumableVideoTask(failed)).toBe(false);
    const running = node("running", CanvasNodeType.Video, { status: "loading", videoTaskId: "t" });
    expect(hasVideoTaskId(running)).toBe(true);
    expect(hasResumableVideoTask(running)).toBe(true);
    // 已有内容后无论在跑与否都不再算任务。
    expect(hasVideoTaskId(node("done", CanvasNodeType.Video, { status: "loading", videoTaskId: "t", content: "v.mp4" }))).toBe(false);
    expect(hasVideoTaskId(node("image", CanvasNodeType.Image, { status: "error", videoTaskId: "t" }))).toBe(false);
});
