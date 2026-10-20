import { useCallback } from "react";
import { z } from "zod";

import { useGatedTool } from "@/components/canvas/tools/use-gated-tool";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

// nodeId 的长度限制在 5 个 schema 里重复出现，抽出来改一处就能生效。
const nodeId = z.string().min(1).max(128);
const idList = z.array(nodeId).min(1).max(50);
const pairInput = z.strictObject({ fromNodeId: nodeId, toNodeId: nodeId });
const position = z.strictObject({ x: z.number().finite().min(-1_000_000).max(1_000_000), y: z.number().finite().min(-1_000_000).max(1_000_000) });
// schema 必须定义在模块作用域：写在 hook 里会每次渲染新建一个对象，
// 让 useGatedTool 的注册回调失效并在每个按键上重新注册工具。
const detailInput = z.strictObject({ nodeId });
const deleteInput = z.strictObject({ nodeIds: idList });

export const updateCanvasNodeInput = z
    .strictObject({
        nodeId,
        title: z.string().trim().min(1).max(120).optional(),
        prompt: z.string().max(4000).optional(),
        content: z.string().max(4000).optional(),
        position: position.optional(),
    })
    .refine(({ title, prompt, content, position: nodePosition }) => title !== undefined || prompt !== undefined || content !== undefined || nodePosition !== undefined, "至少提供一个要修改的字段");

export type UpdateCanvasNodeInput = z.infer<typeof updateCanvasNodeInput>;

// 画布工具统一返回 ok 标志：模型靠它区分「做了」和「没做成」。
// 失败原因和成功回执都是中文句子，不带标志就区分不了。
export type CanvasToolResult = { ok: boolean; message: string };

type CanvasToolsProps = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    onUpdateNode: (input: UpdateCanvasNodeInput) => CanvasToolResult;
    onDeleteNodes: (ids: string[]) => string[];
    onConnectNodes: (fromNodeId: string, toNodeId: string) => CanvasToolResult;
    onDisconnectNodes: (fromNodeId: string, toNodeId: string) => CanvasToolResult;
};

export function useCanvasTools({ nodes, connections, onUpdateNode, onDeleteNodes, onConnectNodes, onDisconnectNodes }: CanvasToolsProps) {
    const titleOf = useCallback((nodeId: string) => nodes.find((node) => node.id === nodeId)?.title || nodeId, [nodes]);

    const getNodeDetail = useCallback(
        ({ nodeId }: { nodeId: string }) => {
            const node = nodes.find((item) => item.id === nodeId);
            if (!node) return { found: false, nodeId };
            const metadata = node.metadata;
            return {
                found: true,
                node: {
                    id: node.id,
                    type: node.type,
                    title: node.title,
                    position: node.position,
                    size: { width: node.width, height: node.height },
                    status: metadata?.status ?? "idle",
                    content: node.type === "text" ? metadata?.content : undefined,
                    prompt: metadata?.prompt,
                    error: metadata?.errorDetails,
                    connections: connections.filter((item) => item.fromNodeId === nodeId || item.toNodeId === nodeId).map((item) => ({ from: item.fromNodeId, to: item.toNodeId })),
                    hasMedia: Boolean(metadata?.storageKey || metadata?.content?.startsWith("/api/media/")),
                },
            };
        },
        [connections, nodes],
    );

    useGatedTool({
        name: "get_node_detail",
        risk: "read",
        description: "读取一个节点的完整文本内容、提示词、位置、状态和相邻连线；不会返回媒体字节或媒体 URL。先从当前画布摘要取得 nodeId。",
        parameters: detailInput,
        handler: getNodeDetail,
    });

    useGatedTool({
        name: "update_node",
        risk: "write",
        description: "修改现有节点的标题、提示词、文本内容或位置。只提交确实需要修改的字段。",
        parameters: updateCanvasNodeInput,
        handler: onUpdateNode,
        summarize: (input) => {
            const fields = [input.title !== undefined && "标题", input.prompt !== undefined && "提示词", input.content !== undefined && "正文内容", input.position !== undefined && "位置"].filter(Boolean).join("、");
            return `修改节点「${titleOf(input.nodeId)}」的${fields}`;
        },
    });

    useGatedTool({
        name: "delete_nodes",
        risk: "write",
        description: "删除指定节点及其关联连线。操作可通过画布撤销。",
        parameters: deleteInput,
        handler: ({ nodeIds }) => ({ deleted: onDeleteNodes(nodeIds) }),
        summarize: ({ nodeIds }) => `删除 ${nodeIds.length} 个节点：${nodeIds.map(titleOf).join("、")}`,
    });

    useGatedTool({
        name: "connect_nodes",
        risk: "write",
        description: "在两个现有节点之间创建数据流连线。参数使用当前画布里的节点 ID。",
        parameters: pairInput,
        handler: ({ fromNodeId, toNodeId }) => onConnectNodes(fromNodeId, toNodeId),
        summarize: ({ fromNodeId, toNodeId }) => `把「${titleOf(fromNodeId)}」连接到「${titleOf(toNodeId)}」`,
    });

    useGatedTool({
        name: "disconnect_nodes",
        risk: "write",
        description: "移除两个现有节点之间的连线。",
        parameters: pairInput,
        handler: ({ fromNodeId, toNodeId }) => onDisconnectNodes(fromNodeId, toNodeId),
        summarize: ({ fromNodeId, toNodeId }) => `断开「${titleOf(fromNodeId)}」到「${titleOf(toNodeId)}」的连线`,
    });
}
