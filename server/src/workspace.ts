import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";
import { withTransaction } from "./db.js";
import { logError } from "./log.js";

const workspaceSchema = z.object({ projects: z.array(z.unknown()), assets: z.array(z.unknown()) }).strict();

// 工作区文档里出现的素材身份。整份文档（含节点元数据、助手会话、资产库）统一扫描，
// 不依赖具体字段位置，新增引用位置不会漏。
const MEDIA_REF = /remote:[0-9a-f-]{36}/gi;

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
    const versionHeader = request.header("if-match-version");
    const version = Number(versionHeader);
    const parsed = workspaceSchema.safeParse(request.body);
    if (!versionHeader || !/^\d+$/.test(versionHeader) || !Number.isSafeInteger(version) || version < 0 || !parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "工作区数据或版本无效" } });
    const result = await database.query<{ version: string }>(
        `INSERT INTO user_workspaces (user_id, version, data) SELECT $1, 1, $2 WHERE $3::bigint = 0 OR EXISTS (SELECT 1 FROM user_workspaces WHERE user_id = $1)
         ON CONFLICT (user_id) DO UPDATE SET version = user_workspaces.version + 1, data = EXCLUDED.data, updated_at = CURRENT_TIMESTAMP
         WHERE user_workspaces.version = $3::bigint
         RETURNING version`,
        [response.locals.user.id, parsed.data, version],
    );
    if (!result.rows[0]) return response.status(409).json({ error: { code: "WORKSPACE_CONFLICT", message: "工作区已在其他页面更新，请重新加载" } });
    // 引用表在工作区写入的同一个 pass 里整体重建：删掉本次文档不再引用的，补齐新增的。
    // 回收任务据此判断哪些媒体已无人引用；重建失败不影响保存成功。
    await syncMediaReferences(database, response.locals.user.id, parsed.data);
    return response.json({ version: result.rows[0].version });
}

async function syncMediaReferences(database: Pool, userId: string, data: unknown) {
    const ids = new Set<string>();
    for (const match of JSON.stringify(data).matchAll(MEDIA_REF)) ids.add(match[0].slice("remote:".length));
    try {
        await withTransaction(database, async (client) => {
            await client.query("DELETE FROM user_media_references WHERE user_id = $1 AND NOT (media_id = ANY($2::uuid[]))", [userId, [...ids]]);
            if (!ids.size) return;
            await client.query("INSERT INTO user_media_references (user_id, media_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT (user_id, media_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP", [userId, [...ids]]);
        });
    } catch (error) {
        logError("media-references", error, { userId });
    }
}
