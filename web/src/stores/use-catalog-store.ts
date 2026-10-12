import { create } from "zustand";

import { fetchServerModels, type PublicModel } from "@/services/api/catalog";

type CatalogState = {
    models: PublicModel[];
    status: "idle" | "loading" | "ready" | "error";
    error: string;
    reset: () => void;
    load: () => Promise<void>;
};

let loading: Promise<void> | null = null;
let revision = 0;

export const useCatalogStore = create<CatalogState>()((set, get) => ({
    models: [],
    status: "idle",
    error: "",
    reset: () => {
        revision++;
        loading = null;
        set({ models: [], status: "idle", error: "" });
    },
    load: async () => {
        if (get().status === "ready") return;
        if (loading) return loading;
        const current = revision;
        set({ status: "loading", error: "" });
        loading = fetchServerModels().then((models) => {
            if (current === revision) set({ models, status: "ready" });
        }).catch((error) => {
            if (current === revision) set({ models: [], status: "error", error: error instanceof Error ? error.message : "模型目录读取失败" });
        }).finally(() => {
            if (current === revision) loading = null;
        });
        return loading;
    },
}));

export function catalogModel(capability: PublicModel["capability"], selected?: string) {
    const models = useCatalogStore.getState().models.filter((model) => model.capability === capability);
    return models.find((model) => model.id === selected) || models[0];
}
