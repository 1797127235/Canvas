import { Router, type Request, type Response } from "express";
import type { RateLimiterPostgres } from "rate-limiter-flexible";
import type { Pool } from "pg";
import { z } from "zod";

import { withTransaction } from "../db.js";
import { createAccount } from "./account-repository.js";
import { createSession, serializeSessionCookie } from "./session.js";
import { normalizeEmail, passwordSchema } from "./schemas.js";
import { hashPassword } from "./passwords.js";
import { consumeRateLimit } from "./rate-limit.js";

const registerInput = z.object({
    email: z.string().min(1),
    password: passwordSchema,
});
const emailSchema = z.string().email();

export type RegisterDependencies = {
    database: Pool;
    limiter: RateLimiterPostgres;
    rateLimitSecret: string;
    secureCookie: boolean;
};

export function createRegisterRouter(dependencies: RegisterDependencies) {
    const router = Router();
    router.post("/users", (request, response) => register(request, response, dependencies));
    return router;
}

async function register(request: Request, response: Response, dependencies: RegisterDependencies) {
    const parsed = registerInput.safeParse(request.body);
    if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "邮箱或密码格式无效" } });

    try {
        await consumeRateLimit(dependencies.limiter, dependencies.rateLimitSecret, "register", request.socket.remoteAddress || "unknown");
    } catch (error) {
        if (isRateLimitRejection(error)) {
            response.setHeader("Retry-After", String(Math.max(1, Math.ceil(error.msBeforeNext / 1000))));
            return response.status(429).json({ error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试" } });
        }
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    }

    const email = normalizeEmail(parsed.data.email);
    if (!emailSchema.safeParse(email).success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "邮箱或密码格式无效" } });
    const passwordHash = await hashPassword(parsed.data.password);
    try {
        const result = await withTransaction(dependencies.database, async (client) => {
            const account = await createAccount(client, email, passwordHash);
            const session = await createSession(client, account.id);
            return { account, session };
        });
        response.setHeader("Set-Cookie", serializeSessionCookie(result.session.sid, dependencies.secureCookie));
        return response.status(201).json({
            user: { id: result.account.id, email: result.account.email },
            expiresAt: result.session.expiresAt.toISOString(),
        });
    } catch (error) {
        if (isUniqueViolation(error)) return response.status(409).json({ error: { code: "EMAIL_EXISTS", message: "该邮箱已注册，请登录" } });
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    }
}

function isUniqueViolation(error: unknown): error is { code: "23505" } {
    return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function isRateLimitRejection(error: unknown): error is { msBeforeNext: number; remainingPoints: number } {
    return typeof error === "object" && error !== null && "msBeforeNext" in error && "remainingPoints" in error && typeof error.msBeforeNext === "number";
}
