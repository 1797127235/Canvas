import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { CanvasToolResult, UpdateCanvasNodeInput } from "@/components/canvas/tools/use-canvas-tools";
import { buildAgentGraph, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";
import { normalizeConnection } from "@/lib/canvas/canvas-node-geometry";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";
import { nanoid } from "nanoid";

type CanvasPoint = { x: number; y: number };

type CanvasAgentActionsOptions = {
    nodesRef: RefObject<CanvasNodeData[]>;
    connectionsRef: RefObject<CanvasConnection[]>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setSelectedNodeIds: Dispatch<SetStateAction<Set<string>>>;
    getCanvasCenter: () => CanvasPoint;
    deleteNodes: (ids: Set<string>) => void;
};

// 只改 patch 里出现的字段，其余保持原样。metadata 必须拷一份再改，
// 不能直接改 node.metadata，否则会改动旧 state 里的对象。
//
// 这个函数不写在 useCallback 里是有原因的：同时传 prompt 和 content 时，
// 早期用「条件展开」的写法会让对象字面量里出现两个 metadata 键，后者覆盖前者，
// 导致 prompt 被静默丢弃。逐字段赋值才是正确的。
export function mergeNodePatch(node: CanvasNodeData, patch: Omit<UpdateCanvasNodeInput, "nodeId">): CanvasNodeData {
    const next = { ...node };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.position) next.position = patch.position;
    if (patch.prompt !== undefined || patch.content !== undefined) {
        next.metadata = { ...node.metadata };
        if (patch.prompt !== undefined) next.metadata.prompt = patch.prompt;
        if (patch.content !== undefined) next.metadata.content = patch.content;
    }
    return next;
}

// 助手写画布的唯一入口：与手工操作走同一套 setNodes/setConnections 与撤销历史。
// 后续加 update/delete/generate 工具时，在这里加方法而不是新开写入通道。
//
// 读当前状态一律走 ref（nodesRef/connectionsRef）而不是 state：
// 这些回调是工具注册的依赖，引用一变就会重新注册工具；走 ref 才能保持引用稳定。
export function useCanvasAgentActions({ nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, getCanvasCenter, deleteNodes }: CanvasAgentActionsOptions) {
    const applyGraph = useCallback(
        (input: ApplyGraphInput): AgentGraphResult => {
            const result = buildAgentGraph(input, nodesRef.current, getCanvasCenter());
            if (result.nodes.length) {
                setNodes((prev) => [...prev, ...result.nodes]);
                setConnections((prev) => [...prev, ...result.connections]);
                setSelectedNodeIds(new Set(result.created.map((item) => item.nodeId)));
            }
            return result;
        },
        [getCanvasCenter, nodesRef, setConnections, setNodes, setSelectedNodeIds],
    );

    const updateNode = useCallback(
        (input: UpdateCanvasNodeInput): CanvasToolResult => {
            const node = nodesRef.current.find((item) => item.id === input.nodeId);
            if (!node) return { ok: false, message: `未找到节点 ${input.nodeId}` };
            if (input.content !== undefined && node.type !== CanvasNodeType.Text) return { ok: false, message: "目前仅支持修改文本节点内容" };
            setNodes((prev) => prev.map((item) => (item.id !== input.nodeId ? item : mergeNodePatch(item, input))));
            return { ok: true, message: `已更新节点「${input.title ?? node.title}」` };
        },
        [nodesRef, setNodes],
    );

    const removeNodes = useCallback(
        (ids: string[]) => {
            const existing = new Set(nodesRef.current.map((node) => node.id));
            const deleted = [...new Set(ids)].filter((id) => existing.has(id));
            if (deleted.length) deleteNodes(new Set(deleted));
            return deleted;
        },
        [deleteNodes, nodesRef],
    );

    const connectNodes = useCallback(
        (fromNodeId: string, toNodeId: string): CanvasToolResult => {
            const normalized = normalizeConnection(fromNodeId, toNodeId, nodesRef.current, "source");
            if (!normalized) return { ok: false, message: "无法连接：节点不存在、目标是分组节点、或连接类型不兼容" };
            if (connectionsRef.current.some((item) => item.fromNodeId === normalized.fromNodeId && item.toNodeId === normalized.toNodeId)) return { ok: false, message: "这条连线已经存在" };
            setConnections((prev) => [...prev, { id: nanoid(), ...normalized }]);
            return { ok: true, message: `已连接 ${normalized.fromNodeId} → ${normalized.toNodeId}` };
        },
        [connectionsRef, nodesRef, setConnections],
    );

    const disconnectNodes = useCallback(
        (fromNodeId: string, toNodeId: string): CanvasToolResult => {
            const exists = connectionsRef.current.some((item) => item.fromNodeId === fromNodeId && item.toNodeId === toNodeId);
            if (!exists) return { ok: false, message: "未找到这条连线" };
            setConnections((prev) => prev.filter((item) => item.fromNodeId !== fromNodeId || item.toNodeId !== toNodeId));
            return { ok: true, message: `已断开 ${fromNodeId} → ${toNodeId}` };
        },
        [connectionsRef, setConnections],
    );

    return { applyGraph, updateNode, removeNodes, connectNodes, disconnectNodes };
}
