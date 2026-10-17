import { createHash, randomBytes } from "node:crypto";

import { Router, type Request, type Response } from "express";
import type { RateLimiterPostgres } from "rate-limiter-flexible";
import type { Pool } from "pg";
import { z } from "zod";

import { withTransaction } from "../db.js";
import { logError } from "../log.js";
import type { Mailer } from "./mailer.js";
import { hashPassword } from "./passwords.js";
import { consumeRateLimit } from "./rate-limit.js";
import { normalizeEmail, passwordSchema } from "./schemas.js";

// 重置链接有效期。过期后需重新申请，旧令牌不延长。
export const PASSWORD_RESET_TTL_SECONDS = 30 * 60;
const TOKEN_BYTES = 32;

const requestInput = z.object({ email: z.string().min(1) });
const confirmInput = z.object({ token: z.string().min(1), password: passwordSchema });

export type PasswordResetDependencies = {
    database: Pool;
    appOrigin: string;
    limiter: RateLimiterPostgres;
    rateLimitSecret: string;
    mailer: Mailer | null;
};

export function createPasswordResetRouter(dependencies: PasswordResetDependencies) {
    const router = Router();
    router.post("/password-resets", (request, response) => requestReset(request, response, dependencies));
    router.post("/password-resets/confirm", (request, response) => confirmReset(request, response, dependencies));
    return router;
}

async function requestReset(request: Request, response: Response, dependencies: PasswordResetDependencies) {
    const parsed = requestInput.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "请输入邮箱" } });
    // 未配置邮件通道时明确失败，避免用户以为邮件已发出。
    if (!dependencies.mailer) return response.status(503).json({ error: { code: "MAIL_NOT_CONFIGURED", message: "邮件服务未配置，请联系管理员重置密码" } });
    try {
        await consumeRateLimit(dependencies.limiter, dependencies.rateLimitSecret, "reset", request.socket.remoteAddress || "unknown");
    } catch (error) {
        if (isRateLimitRejection(error)) {
            response.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.msBeforeNext / 1000))));
            return response.status(429).json({ error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" } });
        }
        logError("password-reset", error, { method: request.method, path: request.path });
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    }

    const email = normalizeEmail(parsed.data.email);
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);
    // 无论邮箱是否存在都返回 204，避免该接口变成账号探测器。
    const userId = await withTransaction(dependencies.database, async (client) => {
        const found = await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
        const account = found.rows[0];
        if (!account) return null;
        // 新申请让该账号此前未用的链接全部失效。
        await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [account.id]);
        await client.query("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, account.id, expiresAt]);
        return account.id;
    });
    if (userId) {
        try {
            await dependencies.mailer.sendPasswordReset(email, `${dependencies.appOrigin}/reset-password?token=${token}`);
        } catch (error) {
            // 发信失败要回滚令牌，否则用户会反复申请却收不到任何邮件。
            await dependencies.database.query("DELETE FROM password_reset_tokens WHERE token_hash = $1", [tokenHash]);
            logError("password-reset", error, { method: request.method, path: request.path });
            return response.status(502).json({ error: { code: "MAIL_FAILED", message: "邮件发送失败，请稍后重试" } });
        }
    }
    return response.status(204).end();
}

async function confirmReset(request: Request, response: Response, dependencies: PasswordResetDependencies) {
    const parsed = confirmInput.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "重置链接或密码格式无效" } });
    const passwordHash = await hashPassword(parsed.data.password);
    const result = await withTransaction(dependencies.database, async (client) => {
        const found = await client.query<{ user_id: string }>(
            "SELECT user_id FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP FOR UPDATE",
            [hashToken(parsed.data.token)],
        );
        const row = found.rows[0];
        if (!row) return false;
        // 重置成功即解除锁定并踢掉全部旧会话：密码换了，旧登录态不该继续有效。
        await client.query("UPDATE users SET password_hash = $2, failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [row.user_id, passwordHash]);
        await client.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
        await client.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [row.user_id]);
        return true;
    });
    if (!result) return response.status(422).json({ error: { code: "INVALID_RESET_TOKEN", message: "重置链接无效或已过期，请重新申请" } });
    return response.status(204).end();
}

function hashToken(token: string) {
    return createHash("sha256").update(token).digest();
}

function isRateLimitRejection(error: unknown): error is { msBeforeNext: number; remainingPoints: number } {
    return typeof error === "object" && error !== null && "msBeforeNext" in error && "remainingPoints" in error && typeof error.msBeforeNext === "number";
}
