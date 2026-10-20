import { useCallback } from "react";

import { useGatedTool } from "@/components/canvas/tools/use-gated-tool";
import { applyGraphInput, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";

const typeLabel: Record<ApplyGraphInput["nodes"][number]["type"], string> = {
    text: "文本",
    image: "图片",
    video: "视频",
    audio: "音频",
    config: "配置",
    generation: "生成",
    edit: "编辑",
};

export function useApplyGraphTool(onApplyGraph: (input: ApplyGraphInput) => AgentGraphResult) {
    const applyGraph = useCallback((input: ApplyGraphInput) => onApplyGraph(input), [onApplyGraph]);
    useGatedTool({
        name: "apply_graph",
        risk: "write",
        description: "在当前画布上一次性创建一组节点和它们之间的连线。一次提交会作为一个整体进入撤销历史。不要用来修改已有节点。",
        parameters: applyGraphInput,
        handler: applyGraph,
        summarize: (input) => {
            const nodes = input.nodes.map((node) => `${typeLabel[node.type]}「${node.title ?? node.key}」`).join("、");
            const links = input.connections?.length ? `，${input.connections.length} 条连线` : "";
            return `新建 ${input.nodes.length} 个节点：${nodes}${links}`;
        },
    });
}
