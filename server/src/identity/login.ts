import { Router, type Request, type Response } from "express";
import type { RateLimiterPostgres } from "rate-limiter-flexible";
import type { Pool } from "pg";
import { z } from "zod";

import { withTransaction } from "../db.js";
import { createSession, serializeSessionCookie } from "./session.js";
import { normalizeEmail, passwordSchema } from "./schemas.js";
import { verifyPassword, verifyUnknownAccount } from "./passwords.js";
import { consumeRateLimit } from "./rate-limit.js";

const loginInput = z.object({ email: z.string().min(1), password: passwordSchema });
const emailSchema = z.string().email();
export const LOGIN_LOCK_SECONDS = 15 * 60;

export type LoginDependencies = {
    database: Pool;
    limiter: RateLimiterPostgres;
    rateLimitSecret: string;
    secureCookie: boolean;
};

export function createLoginRouter(dependencies: LoginDependencies) {
    const router = Router();
    router.post("/sessions", (request, response) => login(request, response, dependencies));
    return router;
}

async function login(request: Request, response: Response, dependencies: LoginDependencies) {
    const parsed = loginInput.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "邮箱或密码格式无效" } });
    const email = normalizeEmail(parsed.data.email);
    if (!emailSchema.safeParse(email).success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "邮箱或密码格式无效" } });

    try {
        await consumeRateLimit(dependencies.limiter, dependencies.rateLimitSecret, "login", request.socket.remoteAddress || "unknown");
    } catch (error) {
        if (isRateLimitRejection(error)) {
            response.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.msBeforeNext / 1000))));
            return response.status(429).json({ error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" } });
        }
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    }

    const result = await withTransaction(dependencies.database, async (client) => {
        // 同一账号的锁定检查、密码验证与会话创建串行化，避免迟到的正确登录解除并发锁定。
        const accountResult = await client.query<{ id: string; email: string; password_hash: string; failed_login_attempts: number; locked_until: Date | null }>(
            "SELECT id, email, password_hash, failed_login_attempts, locked_until FROM users WHERE email = $1 FOR UPDATE", [email],
        );
        const account = accountResult.rows[0];
        if (!account) {
            await verifyUnknownAccount(parsed.data.password);
            return { kind: "invalid" } as const;
        }
        const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        const now = clock.rows[0].now;
        if (account.locked_until && account.locked_until > now) return { kind: "locked" } as const;
        const failures = account.locked_until ? 0 : account.failed_login_attempts;
        if (!await verifyPassword(account.password_hash, parsed.data.password)) {
            const nextFailures = failures + 1;
            await client.query("UPDATE users SET failed_login_attempts = $2, locked_until = $3 WHERE id = $1", [
                account.id, nextFailures, nextFailures >= 5 ? new Date(now.getTime() + LOGIN_LOCK_SECONDS * 1000) : null,
            ]);
            return { kind: "invalid" } as const;
        }
        await client.query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [account.id]);
        const session = await createSession(client, account.id);
        return { kind: "success", user: { id: account.id, email: account.email }, session } as const;
    });
    if (result.kind === "invalid") return response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码错误" } });
    if (result.kind === "locked") return response.status(429).json({ error: { code: "LOGIN_LOCKED", message: "登录暂时受限，请稍后重试" } });
    response.setHeader("Set-Cookie", serializeSessionCookie(result.session.sid, dependencies.secureCookie));
    return response.status(201).json({ user: result.user, expiresAt: result.session.expiresAt.toISOString() });
}

function isRateLimitRejection(error: unknown): error is { msBeforeNext: number; remainingPoints: number } {
    return typeof error === "object" && error !== null && "msBeforeNext" in error && "remainingPoints" in error && typeof error.msBeforeNext === "number";
}
