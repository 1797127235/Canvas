import { create } from "zustand";

import { fetchServerModels, type PublicModel } from "@/services/api/catalog";

type CatalogState = {
    models: PublicModel[];
    status: "idle" | "loading" | "ready" | "error";
    load: () => Promise<void>;
};

let loading: Promise<void> | null = null;

export const useCatalogStore = create<CatalogState>()((set, get) => ({
    models: [],
    status: "idle",
    load: async () => {
        if (get().status === "ready") return;
        if (loading) return loading;
        set({ status: "loading" });
        loading = fetchServerModels().then((models) => set({ models, status: "ready" })).catch(() => set({ models: [], status: "error" })).finally(() => {
            loading = null;
        });
        return loading;
    },
}));

export function catalogModel(capability: PublicModel["capability"], selected?: string) {
    const models = useCatalogStore.getState().models.filter((model) => model.capability === capability);
    return models.find((model) => model.id === selected) || models[0];
}
