import type { ReactNode } from "react";
import { useEffect } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { WorkspaceSync } from "@/components/auth/workspace-sync";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { bypassLocalAuth } from "@/lib/auth-access";
import { subscribeAuthEvents } from "@/lib/auth-tab-sync";
import { useUserStore } from "@/stores/use-user-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const refreshSession = useUserStore((state) => state.refreshSession);

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
                <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
            </div>
            <AgentPanel />
        </div>
    );
}
