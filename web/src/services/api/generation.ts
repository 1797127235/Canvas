import { z } from "zod";
import { useUserStore } from "@/stores/use-user-store";

const responseSchema = z.record(z.string(), z.unknown());

// taskId 由调用方预生成（见 image.ts 同名字段说明）；undefined 会被 JSON.stringify 丢弃。
export async function requestServerGenerationResponse(capability: "image" | "video" | "audio" | "text", modelId: string, input: Record<string, unknown>, signal?: AbortSignal, taskId?: string) {
    const userId = useUserStore.getState().user?.id;
    const response = await fetch("/api/generations", {
        method: "POST", signal,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(userId ? { "X-Account-Id": userId } : {}) },
        body: JSON.stringify({ capability, taskId, modelId, input }),
    });
    if (userId !== useUserStore.getState().user?.id) throw new DOMException("账号已切换", "AbortError");
    if (!response.ok) throw await readGenerationError(response);
    return response;
}

export async function requestServerGeneration(capability: "image" | "video" | "audio" | "text", modelId: string, input: Record<string, unknown>, signal?: AbortSignal, taskId?: string) {
    return responseSchema.parse(await (await requestServerGenerationResponse(capability, modelId, input, signal, taskId)).json());
}

// 建任务要在上游模型发现之后才写库，刚创建的号可能暂时查不到；当作「还在跑」，
// 否则刷新恢复会把自己的任务误判成失败。
export async function pollServerGeneration(id: string, signal?: AbortSignal) {
    const response = await fetch(`/api/generations/${encodeURIComponent(id)}`, { credentials: "same-origin", signal, headers: { Accept: "application/json" } });
    if (response.status === 404) return { status: "running" };
    if (!response.ok) throw await readGenerationError(response);
    return responseSchema.parse(await response.json());
}

async function readGenerationError(response: Response) {
    try {
        const payload = (await response.json()) as { error?: { message?: string } };
        return new Error(payload.error?.message || "服务端生成失败");
    } catch {
        return new Error("服务端生成失败");
    }
}
