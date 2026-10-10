import { create } from "zustand";

import { publishAuthEvent } from "@/lib/auth-tab-sync";

import {
    getSession,
    IdentityApiError,
    login as loginRequest,
    logout as logoutRequest,
    register as registerRequest,
    type AuthInput,
    type CurrentUser,
} from "@/services/api/identity";

export type UserStatus = "loading" | "guest" | "authenticated" | "error";

type UserStore = {
    status: UserStatus;
    user: CurrentUser | null;
    expiresAt: string | null;
    error: Error | null;
    refreshSession: () => Promise<void>;
    register: (input: AuthInput) => Promise<void>;
    login: (input: AuthInput) => Promise<void>;
    logout: () => Promise<void>;
    clearSession: (broadcast?: boolean) => void;
};

let revision = 0;
let pendingChanges = 0;

export const useUserStore = create<UserStore>()((set, get) => ({
    status: "loading",
    user: null,
    expiresAt: null,
    error: null,
    refreshSession: async () => {
        if (pendingChanges) return;
        const requestRevision = ++revision;
        if (get().status !== "authenticated") set({ status: "loading", error: null });
        try {
            const session = await getSession();
            if (requestRevision !== revision) return;
            set({ status: "authenticated", user: session.user, expiresAt: session.expiresAt, error: null });
        } catch (error) {
            if (requestRevision !== revision) return;
            if (error instanceof IdentityApiError && error.status === 401) {
                const expired = get().user !== null;
                set({ status: "guest", user: null, expiresAt: null, error: null });
                if (expired) publishAuthEvent("session-expired");
                return;
            }
            set({ status: "error", error: error instanceof Error ? error : new Error("身份服务暂时不可用") });
        }
    },
    register: async (input) => {
        const requestRevision = ++revision;
        pendingChanges++;
        try {
            const session = await registerRequest(input);
            if (requestRevision !== revision) return;
            set({ status: "authenticated", user: session.user, expiresAt: session.expiresAt, error: null });
            publishAuthEvent("login");
        } finally {
            pendingChanges--;
        }
    },
    login: async (input) => {
        const requestRevision = ++revision;
        pendingChanges++;
        try {
            const session = await loginRequest(input);
            if (requestRevision !== revision) return;
            set({ status: "authenticated", user: session.user, expiresAt: session.expiresAt, error: null });
            publishAuthEvent("login");
        } finally {
            pendingChanges--;
        }
    },
    logout: async () => {
        const requestRevision = ++revision;
        pendingChanges++;
        try {
            await logoutRequest();
            if (requestRevision !== revision) return;
            set({ status: "guest", user: null, expiresAt: null, error: null });
            publishAuthEvent("logout");
        } finally {
            pendingChanges--;
        }
    },
    clearSession: (broadcast = true) => {
        revision++;
        set({ status: "guest", user: null, expiresAt: null, error: null });
        if (broadcast) publishAuthEvent("logout");
    },
}));
