import { create } from "zustand";

import type { CanvasOp, CanvasOpsSnapshot } from "@/lib/canvas/canvas-ops";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";

export type AgentChatRole = "user" | "assistant" | "system" | "tool" | "error";
export type AgentAttachment = { id: string; name: string; type: string; size: number; width: number; height: number; url: string; dataUrl: string };
export type AgentMessageAttachment = Pick<AgentAttachment, "id" | "name" | "url"> & Partial<Pick<AgentAttachment, "type" | "size" | "width" | "height" | "dataUrl">>;
export type AgentCanvasReference = Pick<CanvasResourceReference, "nodeId" | "label" | "title" | "kind" | "previewUrl" | "text">;
export type AgentChatItem = {
    id: string;
    itemId?: string;
    clientMessageId?: string;
    threadId?: string;
    turnId?: string;
    role: AgentChatRole;
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: AgentMessageAttachment[];
    canvasReferences?: AgentCanvasReference[];
    streamId?: string;
};
export type AgentCanvasContext = { snapshot: CanvasOpsSnapshot; applyOps: (ops?: CanvasOp[]) => CanvasOpsSnapshot; undoOps: () => CanvasOpsSnapshot | null; canUndo: boolean };
export type AgentTokenUsage = { input: number; cached: number; output: number };

export const CANVAS_AGENT_PANEL_MOTION_MS = 500;

type AgentStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    canvasContext: AgentCanvasContext | null;
    prompt: string;
    attachments: AgentAttachment[];
    canvasReferences: CanvasResourceReference[];
    sending: boolean;
    waiting: boolean;
    messages: AgentChatItem[];
    tokenUsage: AgentTokenUsage | null;
    activeThreadId: string;
    activeTurnId: string;
    setAgentState: (patch: Partial<Omit<AgentStore, "setAgentState" | "openPanel" | "closePanel" | "togglePanel" | "setCanvasContext" | "addMessage">>) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
    setCanvasContext: (context: AgentCanvasContext | null) => void;
    addMessage: (item: AgentChatItem) => void;
};

export const useAgentStore = create<AgentStore>((set, get) => ({
    width: typeof window === "undefined" ? 440 : Number(localStorage.getItem("canvas-agent-panel-width")) || 440,
    panelOpen: false,
    panelMounted: true,
    panelClosing: false,
    canvasContext: null,
    prompt: "",
    attachments: [],
    canvasReferences: [],
    sending: false,
    waiting: false,
    messages: [],
    tokenUsage: null,
    activeThreadId: "",
    activeTurnId: "",
    setAgentState: (patch) => set(patch),
    openPanel: () => set({ panelOpen: true, panelMounted: true, panelClosing: false }),
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelClosing: false });
        }, CANVAS_AGENT_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
    setCanvasContext: (canvasContext) => set({ canvasContext }),
    addMessage: (item) => set((state) => ({ messages: [...state.messages, item] })),
}));
