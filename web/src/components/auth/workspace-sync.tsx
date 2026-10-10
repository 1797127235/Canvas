import { useEffect, useRef } from "react";

import { getWorkspace, saveWorkspace, type WorkspaceData } from "@/services/api/workspace";
import { useUserStore } from "@/stores/use-user-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { bypassLocalAuth } from "@/lib/auth-access";

export function WorkspaceSync() {
    const status = useUserStore((state) => state.status);
    const userId = useUserStore((state) => state.user?.id);
    const versionRef = useRef("0");
    const readyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (bypassLocalAuth || status !== "authenticated" || !userId) {
            readyRef.current = false;
            versionRef.current = "0";
            useCanvasStore.getState().replaceProjects([]);
            useAssetStore.getState().replaceAssets([]);
            return;
        }
        let cancelled = false;
        readyRef.current = false;
        void getWorkspace().then((remote) => {
            if (cancelled) return;
            versionRef.current = remote.version;
            useCanvasStore.getState().replaceProjects(remote.data.projects);
            useAssetStore.getState().replaceAssets(remote.data.assets);
            readyRef.current = true;
        }).catch(() => {
            readyRef.current = false;
        });
        return () => {
            cancelled = true;
            readyRef.current = false;
        };
    }, [status, userId]);

    useEffect(() => {
        if (bypassLocalAuth || status !== "authenticated" || !userId) return;
        const persist = () => {
            if (!readyRef.current) return;
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
                timerRef.current = null;
                const data: WorkspaceData = { projects: useCanvasStore.getState().projects, assets: useAssetStore.getState().assets };
                void saveWorkspace(versionRef.current, data).then((result) => {
                    versionRef.current = result.version;
                }).catch(() => undefined);
            }, 400);
        };
        const unsubscribeCanvas = useCanvasStore.subscribe(persist);
        const unsubscribeAssets = useAssetStore.subscribe(persist);
        return () => {
            unsubscribeCanvas();
            unsubscribeAssets();
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [status, userId]);

    return null;
}
