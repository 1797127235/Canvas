import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";
import { encryptCredential, decryptCredential } from "./credential-crypto.js";

export { encryptCredential, decryptCredential };

// 服务端内部取账号凭据的入口：目录查询和生成链路用它调用上游。
// 未配置加密密钥或该账号没存 Key 时返回 null，由调用方决定报错，不在这一层抛异常。
export async function readUserCredential(database: Pool, userId: string, encryptionKey?: string): Promise<UserCredential | null> {
    if (!encryptionKey) return null;
    const result = await database.query<{ encrypted_api_key: Buffer; base_url: string | null }>("SELECT encrypted_api_key, base_url FROM user_credentials WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    return row ? { apiKey: decryptCredential(row.encrypted_api_key, encryptionKey), baseUrl: row.base_url } : null;
}

// 账号可以自带上游地址覆盖部署目录里的共用地址；没配就沿用目录配置。
export type UserCredential = { apiKey: string; baseUrl: string | null };

// 上游地址不是秘密，明文保存。只接受 http(s)、无凭据/查询/片段的地址，并去掉末尾斜杠。
// 要求带显式路径前缀（如 /v1），避免根地址拼出 https://host/models 这种错路径。
export function normalizeBaseUrl(value: string) {
    try {
        const url = new URL(value.trim());
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (url.username || url.password || url.search || url.hash || url.pathname === "/") return null;
        return url.toString().replace(/\/+$/, "");
    } catch {
        return null;
    }
}

// 上限 4096 只挡明显异常的超长输入，Key 的真实长度由上游决定。
// 两个字段可以单独提交：只传 apiKey 保存 Key，只传 baseUrl 改上游地址（空串表示回落到目录默认）。
const inputSchema = z.object({
    apiKey: z.string().min(1).max(4096).optional(),
    baseUrl: z.string().trim().max(2048).optional(),
}).refine((value) => value.apiKey !== undefined || value.baseUrl !== undefined, { message: "缺少要保存的字段" });
type CredentialOptions = { encryptionKey?: string };

export function createCredentialRouter(database: Pool, options: CredentialOptions) {
    const router = Router();
    router.use(requireUser(database));
    router.get("/credentials", (request, response) => getCredential(request, response, database, options));
    router.put("/credentials", (request, response) => putCredential(request, response, database, options));
    router.delete("/credentials", (request, response) => deleteCredential(request, response, database));
    return router;
}

// 只回掩码和上游地址，明文 Key 不离开服务端。
async function getCredential(_request: Request, response: Response, database: Pool, options: CredentialOptions) {
    if (!options.encryptionKey) return response.status(503).json({ error: { code: "CREDENTIALS_NOT_CONFIGURED", message: "账号配置尚未启用" } });
    const result = await database.query<{ encrypted_api_key: Buffer; base_url: string | null }>("SELECT encrypted_api_key, base_url FROM user_credentials WHERE user_id = $1", [response.locals.user.id]);
    const row = result.rows[0];
    return response.json({
        configured: Boolean(row),
        masked: row ? maskApiKey(decryptCredential(row.encrypted_api_key, options.encryptionKey)) : null,
        baseUrl: row?.base_url ?? null,
    });
}

async function putCredential(request: Request, response: Response, database: Pool, options: CredentialOptions) {
    if (!options.encryptionKey) return response.status(503).json({ error: { code: "CREDENTIALS_NOT_CONFIGURED", message: "账号配置尚未启用" } });
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "账号配置格式无效" } });
    const userId = response.locals.user.id;
    // baseUrl 缺省表示不动已配置的地址，空串才回落到部署目录里的默认上游。
    const raw = parsed.data.baseUrl;
    const baseUrl = raw === undefined ? undefined : raw ? normalizeBaseUrl(raw) : null;
    if (raw && !baseUrl) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "上游地址无效，需为 http(s) 地址并带路径前缀，例如 https://api.example.com/v1" } });
    if (parsed.data.apiKey !== undefined) {
        // 每个账号只有一把 Key，重复保存直接覆盖；清除后旧 Key 立即失效。
        const encrypted = encryptCredential(parsed.data.apiKey, options.encryptionKey);
        if (baseUrl === undefined) {
            await database.query(
                `INSERT INTO user_credentials (user_id, encrypted_api_key) VALUES ($1, $2)
                 ON CONFLICT (user_id) DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, updated_at = CURRENT_TIMESTAMP`,
                [userId, encrypted],
            );
        } else {
            await database.query(
                `INSERT INTO user_credentials (user_id, encrypted_api_key, base_url) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id) DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, base_url = EXCLUDED.base_url, updated_at = CURRENT_TIMESTAMP`,
                [userId, encrypted, baseUrl],
            );
        }
        return response.status(204).end();
    }
    // 上游地址依附于 Key，没有 Key 时先保存地址没有意义。
    const updated = await database.query("UPDATE user_credentials SET base_url = $2, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1", [userId, baseUrl ?? null]);
    if (!updated.rowCount) return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先保存账号 API Key" } });
    return response.status(204).end();
}

async function deleteCredential(_request: Request, response: Response, database: Pool) {
    await database.query("DELETE FROM user_credentials WHERE user_id = $1", [response.locals.user.id]);
    return response.status(204).end();
}

// 掩码用于前端回显「已配置」：保留前后各 4 位便于辨认，中间位数封顶避免暴露真实长度。
function maskApiKey(value: string) {
    return value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}${"•".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}
