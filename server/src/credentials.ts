import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";

import { requireUser } from "./identity/auth-middleware.js";
import { encryptCredential, decryptCredential } from "./credential-crypto.js";

export { encryptCredential, decryptCredential };

const inputSchema = z.object({ apiKey: z.string().min(1).max(4096) });
type CredentialOptions = { encryptionKey?: string };

export function createCredentialRouter(database: Pool, options: CredentialOptions) {
    const router = Router();
    router.use(requireUser(database));
    router.get("/credentials", (request, response) => getCredential(request, response, database, options));
    router.put("/credentials", (request, response) => putCredential(request, response, database, options));
    router.delete("/credentials", (request, response) => deleteCredential(request, response, database));
    return router;
}

async function getCredential(_request: Request, response: Response, database: Pool, options: CredentialOptions) {
    if (!options.encryptionKey) return response.status(503).json({ error: { code: "CREDENTIALS_NOT_CONFIGURED", message: "账号配置尚未启用" } });
    const result = await database.query<{ encrypted_api_key: Buffer }>("SELECT encrypted_api_key FROM user_credentials WHERE user_id = $1", [response.locals.user.id]);
    const encrypted = result.rows[0]?.encrypted_api_key;
    return response.json({ configured: Boolean(encrypted), masked: encrypted ? maskApiKey(decryptCredential(encrypted, options.encryptionKey)) : null });
}

async function putCredential(request: Request, response: Response, database: Pool, options: CredentialOptions) {
    if (!options.encryptionKey) return response.status(503).json({ error: { code: "CREDENTIALS_NOT_CONFIGURED", message: "账号配置尚未启用" } });
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "API Key 格式无效" } });
    const encrypted = encryptCredential(parsed.data.apiKey, options.encryptionKey);
    await database.query(
        `INSERT INTO user_credentials (user_id, encrypted_api_key) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET encrypted_api_key = EXCLUDED.encrypted_api_key, updated_at = CURRENT_TIMESTAMP`,
        [response.locals.user.id, encrypted],
    );
    return response.status(204).end();
}

async function deleteCredential(_request: Request, response: Response, database: Pool) {
    await database.query("DELETE FROM user_credentials WHERE user_id = $1", [response.locals.user.id]);
    return response.status(204).end();
}

function maskApiKey(value: string) {
    return value.length <= 8 ? "••••••••" : `${value.slice(0, 4)}${"•".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}
