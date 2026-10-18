import { z } from "zod";

import { createCanvasNode } from "@/lib/canvas/canvas-node-factory";
import { getNodeDefinition, getNodeSpec } from "@/lib/canvas/node-registry";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type Position } from "@/types/canvas";

// apply_graph 的入参。故意不接受坐标：createCanvasNode 把传入坐标当中心点，
// 模型既不知道视口大小也不知道已有节点占位，让它编坐标必然重叠。位置由下面的布局算。
const nodeInput = z.strictObject({
    key: z.string().min(1).max(64),
    type: z.string().min(1).max(32),
    title: z.string().trim().max(120).optional(),
    prompt: z.string().max(4000).optional(),
    content: z.string().max(4000).optional(),
    storageKey: z.string().max(200).optional(),
});

export const applyGraphInput = z.strictObject({
    nodes: z.array(nodeInput).min(1).max(20),
    connections: z.array(z.strictObject({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) })).max(40).optional(),
});

export type ApplyGraphInput = z.infer<typeof applyGraphInput>;

export type AgentGraphResult = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    created: { key: string; nodeId: string }[];
    // 单条被拒不影响整批：一个不合法的节点不该让其余节点白建，
    // 但必须明确告诉模型哪几条没落地，否则它会以为画布已经是它想的样子。
    warnings: string[];
};

const GAP = 60;

export function buildAgentGraph(input: ApplyGraphInput, existing: CanvasNodeData[], origin: Position): AgentGraphResult {
    const created: { key: string; nodeId: string }[] = [];
    const nodes: CanvasNodeData[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const bounds = existingBounds(existing);

    // 从视口中心起算；画布上已经有内容时排到最右侧内容的右边，避免盖住用户正在看的东西。
    let cursorX = bounds ? Math.max(origin.x, bounds.maxX + GAP) : origin.x;
    for (const item of input.nodes) {
        if (seen.has(item.key)) {
            warnings.push(`key「${item.key}」重复，已跳过`);
            continue;
        }
        seen.add(item.key);
        if (!getNodeDefinition(item.type)) {
            warnings.push(`不支持的节点类型「${item.type}」，已跳过`);
            continue;
        }
        const spec = getNodeSpec(item.type);
        const center: Position = { x: cursorX + spec.width / 2, y: origin.y };
        const node = createCanvasNode(item.type, center, nodeMetadata(item));
        nodes.push(node);
        created.push({ key: item.key, nodeId: node.id });
        cursorX += spec.width + GAP;
    }

    const nodeIdByKey = new Map(created.map((item) => [item.key, item.nodeId]));
    const connections: CanvasConnection[] = [];
    for (const link of input.connections ?? []) {
        const fromNodeId = nodeIdByKey.get(link.from);
        const toNodeId = nodeIdByKey.get(link.to);
        if (!fromNodeId || !toNodeId) {
            warnings.push(`连线 ${link.from} → ${link.to} 引用了不存在的节点，已跳过`);
            continue;
        }
        if (fromNodeId === toNodeId) {
            warnings.push(`连线 ${link.from} → ${link.to} 是自环，已跳过`);
            continue;
        }
        connections.push({ id: `connection-${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });
    }

    return { nodes, connections, created, warnings };
}

// 文本节点装内容，媒体节点装身份。storageKey 允许 remote:<uuid>（引用已有资产或生成结果），
// 归属校验仍由服务端在读取字节时做，这里只负责把 url 拼出来。
function nodeMetadata(item: ApplyGraphInput["nodes"][number]): CanvasNodeMetadata {
    if (item.type === CanvasNodeType.Text) return { content: item.content ?? item.prompt ?? "", status: "success" };
    const storageKey = item.storageKey?.trim();
    if (!storageKey) return { prompt: item.prompt, status: "idle" };
    const mediaId = storageKey.startsWith("remote:") ? storageKey.slice("remote:".length) : "";
    return { prompt: item.prompt, storageKey, content: mediaId ? `/api/media/${mediaId}` : undefined, status: "success" };
}

function existingBounds(nodes: CanvasNodeData[]) {
    if (!nodes.length) return null;
    let maxX = -Infinity;
    for (const node of nodes) maxX = Math.max(maxX, node.position.x + node.width);
    return { maxX };
}
