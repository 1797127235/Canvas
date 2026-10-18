import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

// 摘要只给「能定位和判断」的字段：id、类型、标题、位置尺寸、状态、提示词前 120 字、有没有素材。
// 不给 content 全文 / base64 / images 数组——二十个节点的全量元数据会吃掉大半上下文窗口，
// 而模型此刻只需要知道「有什么、在哪、什么状态」。要看全文得靠后续的 get_node_detail 工具。
const PROMPT_LIMIT = 120;
const ASSET_LIMIT = 40;

// 与 useAgentContext 的 JsonSerializable 对齐：undefined 不是合法 JSON，缺字段而不是留 undefined。
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type AgentContextBlock = { description: string; value: Record<string, JsonValue> };

export function buildCanvasContext(nodes: CanvasNodeData[], connections: CanvasConnection[], selectedNodeIds: Set<string>): AgentContextBlock {
    return {
        description: "当前画布",
        value: {
            nodes: nodes.map((node) => ({
                id: node.id,
                type: node.type,
                title: node.title,
                position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
                size: { width: Math.round(node.width), height: Math.round(node.height) },
                status: node.metadata?.status ?? "idle",
                prompt: truncate(node.metadata?.prompt || (node.type === CanvasNodeType.Text ? node.metadata?.content : "") || ""),
                hasMedia: Boolean(node.metadata?.storageKey || node.metadata?.content?.startsWith("/api/media/")),
            })),
            connections: connections.map((connection) => ({ from: connection.fromNodeId, to: connection.toNodeId })),
            selectedNodeIds: [...selectedNodeIds],
        },
    };
}

export function buildAssetsContext(assets: Asset[]): AgentContextBlock {
    return {
        description: "资产库（建节点时可用 storageKey 引用）",
        value: {
            assets: assets.slice(0, ASSET_LIMIT).map((asset) => ({
                kind: asset.kind,
                title: asset.title,
                storageKey: asset.kind === "text" ? null : (asset.data.storageKey ?? null),
            })),
            total: assets.length,
        },
    };
}

function truncate(value: string) {
    const text = value.trim().replace(/\s+/g, " ");
    return text.length > PROMPT_LIMIT ? `${text.slice(0, PROMPT_LIMIT)}…` : text;
}
