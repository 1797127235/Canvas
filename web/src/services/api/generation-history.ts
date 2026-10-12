import { bypassLocalAuth } from "@/lib/auth-access";
import { useUserStore } from "@/stores/use-user-store";

type Kind = "image" | "video";

export function generationHistoryStore<T extends { id: string }>(kind: Kind, local: LocalForage, userId = useUserStore.getState().user?.id) {
    const request = async (id = "", init?: RequestInit) => {
        if (!userId || userId !== useUserStore.getState().user?.id) throw new Error("账号已切换，操作已取消");
        const response = await fetch(`/api/generation-history/${kind}${id ? `/${encodeURIComponent(id)}` : ""}`, { credentials: "same-origin", ...init, headers: { ...init?.headers, "X-Account-Id": userId } });
        if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换，操作已取消");
        if (!response.ok) throw new Error("生成记录读写失败");
        return response;
    };
    return {
        read: async (): Promise<T[]> => {
            if (!bypassLocalAuth) return (await (await request()).json() as { logs: T[] }).logs;
            const logs: T[] = [];
            await local.iterate<T, void>(value => { logs.push(value); });
            return logs;
        },
        setItem: async (id: string, value: T) => {
            if (bypassLocalAuth) return local.setItem(id, value);
            await request(id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
        },
        removeItem: async (id: string) => {
            if (bypassLocalAuth) return local.removeItem(id);
            await request(id, { method: "DELETE" });
        },
    };
}
