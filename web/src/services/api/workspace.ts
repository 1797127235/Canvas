import type { Asset } from "@/stores/use-asset-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useUserStore } from "@/stores/use-user-store";

export type WorkspaceData = { projects: CanvasProject[]; assets: Asset[] };
export type WorkspaceResponse = { version: string; data: WorkspaceData };

export async function getWorkspace() {
    const response = await fetch("/api/workspace", { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("工作区读取失败");
    return (await response.json()) as WorkspaceResponse;
}

export async function saveWorkspace(version: string, data: WorkspaceData, userId = useUserStore.getState().user?.id) {
    if (!userId || userId !== useUserStore.getState().user?.id) throw new Error("账号已切换，保存已取消");
    const response = await fetch("/api/workspace", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "If-Match-Version": version, "X-Account-Id": userId, Accept: "application/json" }, body: JSON.stringify(data) });
    if (userId !== useUserStore.getState().user?.id) throw new Error("账号已切换，保存已取消");
    if (response.status === 409) throw new Error("WORKSPACE_CONFLICT");
    if (!response.ok) throw new Error("工作区保存失败");
    return (await response.json()) as { version: string };
}
