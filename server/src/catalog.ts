import { Router } from "express";
import type { Pool } from "pg";
import type { Catalog } from "./catalog/catalog.js";
import { accountModels, publicModels } from "./catalog/catalog.js";
import { readUserApiKey } from "./credentials.js";
import { requireUser } from "./identity/auth-middleware.js";

export function createCatalogRouter(catalog: Catalog, database: Pool, encryptionKey?: string) {
    const router = Router();
    router.get("/models", requireUser(database), async (_request, response) => {
        const apiKey = await readUserApiKey(database, response.locals.user.id, encryptionKey);
        if (!apiKey) return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } });
        try {
            return response.json({ models: publicModels({ models: await accountModels(catalog, apiKey) }) });
        } catch {
            return response.status(502).json({ error: { code: "UPSTREAM_ERROR", message: "上游模型获取失败，请检查账号 API Key 和上游服务" } });
        }
    });
    return router;
}
