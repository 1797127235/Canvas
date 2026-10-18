import type { ReactNode } from "react";
import { useEffect } from "react";

import { WorkspaceSync } from "@/components/auth/workspace-sync";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { bypassLocalAuth } from "@/lib/auth-access";
import { subscribeAuthEvents } from "@/lib/auth-tab-sync";
import { useUserStore } from "@/stores/use-user-store";
import { useCatalogStore } from "@/stores/use-catalog-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const refreshSession = useUserStore((state) => state.refreshSession);
    const userId = useUserStore((state) => state.user?.id);
    const workspaceError = useWorkspaceStore((state) => state.error);

    useEffect(() => {
        if (bypassLocalAuth) return;
        useCatalogStore.getState().reset();
        if (userId) void useCatalogStore.getState().load();
    }, [userId]);

    useEffect(() => {
        if (bypassLocalAuth) {
            useUserStore.getState().clearSession(false);
            return;
        }
        void refreshSession();
        const unsubscribe = subscribeAuthEvents((type) => {
            if (type === "logout" || type === "session-expired") useUserStore.getState().clearSession(false);
            if (type === "login") void useUserStore.getState().refreshSession();
        });
        const handleVisibility = () => {
            if (document.visibilityState === "visible") void refreshSession();
        };
        document.addEventListener("visibilitychange", handleVisibility);
        return () => {
            unsubscribe();
            document.removeEventListener("visibilitychange", handleVisibility);
        };
    }, [refreshSession]);

    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <WorkspaceSync />
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <AppTopNav />
                {workspaceError ? <div role="alert" className="px-4 py-2 text-sm text-destructive">{workspaceError}</div> : null}
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
        </div>
    );
}
