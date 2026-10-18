import { useCallback } from "react";
import { useFrontendTool } from "@copilotkit/react-core/v2";

import { applyGraphInput, type AgentGraphResult, type ApplyGraphInput } from "@/lib/canvas/canvas-agent-graph";

export function useApplyGraphTool(onApplyGraph: (input: ApplyGraphInput) => AgentGraphResult) {
    const applyGraph = useCallback((args: unknown) => onApplyGraph(applyGraphInput.parse(args)), [onApplyGraph]);
    useFrontendTool(
        {
            name: "apply_graph",
            description: "在当前画布上一次性创建一组节点和它们之间的连线。一次提交会作为一个整体进入撤销历史。不要用来修改已有节点。",
            parameters: applyGraphInput,
            handler: async (args) => applyGraph(args),
        },
        [applyGraph],
    );
}
