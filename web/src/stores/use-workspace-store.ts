import { create } from "zustand";

type WorkspaceState = {
    owner: string | null;
    status: "loading" | "ready" | "error";
    error: string;
    flush: (() => Promise<void>) | null;
};

export const useWorkspaceStore = create<WorkspaceState>()(() => ({ owner: null, status: "loading", error: "", flush: null }));
