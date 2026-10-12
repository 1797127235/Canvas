import { useEffect } from "react";

import { getWorkspace, saveWorkspace } from "@/services/api/workspace";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";
import { bypassLocalAuth } from "@/lib/auth-access";

export function WorkspaceSync() {
    const userId = useUserStore((state) => state.user?.id);

    useEffect(() => {
        if (bypassLocalAuth) return;
        let cancelled = false;
        let ready = false;
        let dirty = false;
        let failed = false;
        let conflicted = false;
        let version = "0";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let pending: Promise<void> | null = null;
        const current = () => !cancelled && userId === useUserStore.getState().user?.id;
        useWorkspaceStore.setState({ owner: userId || null, status: "loading", error: "", flush: null });
        useCanvasStore.getState().replaceProjects([]);
        useAssetStore.getState().replaceAssets([]);
        if (!userId) return;
        const flush = (): Promise<void> => {
            if (timer) clearTimeout(timer);
            if (pending) return pending;
            if (conflicted) return Promise.reject(new Error("工作区版本冲突，请先导出当前画布"));
            failed = false;
            pending = (async () => {
                while (dirty && ready && current() && !failed) {
                    dirty = false;
                    const data = { projects: useCanvasStore.getState().projects, assets: useAssetStore.getState().assets };
                    try {
                        const result = await saveWorkspace(version, data, userId);
                        if (current()) {
                            version = result.version;
                            useWorkspaceStore.setState({ status: "ready", error: "" });
                        }
                    } catch (error) {
                        failed = true;
                        conflicted = error instanceof Error && error.message === "WORKSPACE_CONFLICT";
                        dirty = true;
                        if (current()) useWorkspaceStore.setState({ status: "error", error: error instanceof Error && error.message === "WORKSPACE_CONFLICT" ? "工作区已在其他页面更新。当前编辑已保留，请刷新前先导出画布。" : "工作区保存失败，当前编辑已保留，请检查网络后重试。" });
                        throw error;
                    }
                }
            })().finally(() => { pending = null; });
            return pending;
        };
        const persist = () => {
            if (!ready || !current()) return;
            dirty = true;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { void flush().catch(() => undefined); }, 400);
        };
        void getWorkspace().then((remote) => {
            if (!current()) return;
            version = remote.version;
            useCanvasStore.getState().replaceProjects(remote.data.projects);
            useAssetStore.getState().replaceAssets(remote.data.assets);
            ready = true;
            useWorkspaceStore.setState({ status: "ready", flush });
        }).catch((error) => {
            if (current()) useWorkspaceStore.setState({ status: "error", error: error instanceof Error ? error.message : "工作区读取失败" });
        });
        const unsubscribeCanvas = useCanvasStore.subscribe((state, previous) => { if (state.projects !== previous.projects) persist(); });
        const unsubscribeAssets = useAssetStore.subscribe((state, previous) => { if (state.assets !== previous.assets) persist(); });
        const unload = (event: BeforeUnloadEvent) => { if (dirty || pending) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", unload);
        return () => {
            cancelled = true;
            ready = false;
            if (timer) clearTimeout(timer);
            unsubscribeCanvas();
            unsubscribeAssets();
            window.removeEventListener("beforeunload", unload);
        };
    }, [userId]);

    return null;
}
