import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ApprovalMode, ToolPolicy } from "@/lib/agent/tool-approval";

// 执行许可是设备级偏好（跟主题一样），不跟账号走：同一浏览器多账号共用一套设置。
// sessionAllow 只放内存，刷新即失效——花钱类工具的「本次会话放行」不应该跨会话生效。
type AgentPermissionStore = {
    mode: ApprovalMode;
    overrides: Record<string, ToolPolicy>;
    sessionAllow: Record<string, true>;
    setMode: (mode: ApprovalMode) => void;
    setOverride: (tool: string, policy?: ToolPolicy) => void;
    allowForSession: (tool: string) => void;
    reset: () => void;
};

export const useAgentPermissionStore = create<AgentPermissionStore>()(
    persist(
        (set) => ({
            mode: "ask",
            overrides: {},
            sessionAllow: {},
            setMode: (mode) => set({ mode }),
            setOverride: (tool, policy) =>
                set((state) => {
                    const overrides = { ...state.overrides };
                    if (policy) overrides[tool] = policy;
                    else delete overrides[tool];
                    return { overrides };
                }),
            allowForSession: (tool) => set((state) => ({ sessionAllow: { ...state.sessionAllow, [tool]: true } })),
            reset: () => set({ mode: "ask", overrides: {}, sessionAllow: {} }),
        }),
        {
            name: "infinite-canvas:agent_permission",
            // sessionAllow 不落盘：只持久化模式和单工具覆盖。
            partialize: (state) => ({ mode: state.mode, overrides: state.overrides }),
        },
    ),
);
