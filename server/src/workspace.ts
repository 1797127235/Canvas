import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";

const workspaceSchema = z.object({ projects: z.array(z.unknown()), assets: z.array(z.unknown()) }).strict();

export function createWorkspaceRouter(database: Pool) {
    const router = Router();
    router.use(requireUser(database));
    router.get("/workspace", (request, response) => getWorkspace(request, response, database));
    router.put("/workspace", (request, response) => putWorkspace(request, response, database));
    return router;
}

async function getWorkspace(_request: Request, response: Response, database: Pool) {
    const result = await database.query<{ version: string; data: unknown }>("SELECT version, data FROM user_workspaces WHERE user_id = $1", [response.locals.user.id]);
    const row = result.rows[0];
    return response.json({ version: row?.version || "0", data: row?.data || { projects: [], assets: [] } });
}

async function putWorkspace(request: Request, response: Response, database: Pool) {
    const version = Number(request.header("if-match-version"));
    const parsed = workspaceSchema.safeParse(request.body);
    if (!Number.isSafeInteger(version) || version < 0 || !parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "工作区数据或版本无效" } });
    const result = await database.query<{ version: string }>(
        `INSERT INTO user_workspaces (user_id, version, data) VALUES ($1, 1, $2)
         ON CONFLICT (user_id) DO UPDATE SET version = user_workspaces.version + 1, data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
         WHERE user_workspaces.version = $3
         RETURNING version`,
        [response.locals.user.id, parsed.data, version],
    );
    if (!result.rows[0]) return response.status(409).json({ error: { code: "WORKSPACE_CONFLICT", message: "工作区已在其他页面更新，请重新加载" } });
    return response.json({ version: result.rows[0].version });
}
