import { Router } from "express";
import type { Catalog } from "./catalog/catalog.js";
import { publicModels } from "./catalog/catalog.js";

export function createCatalogRouter(catalog: Catalog) {
    const router = Router();
    router.get("/models", (_request, response) => response.json({ models: publicModels(catalog) }));
    return router;
}
