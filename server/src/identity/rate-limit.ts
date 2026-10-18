import { createHmac } from "node:crypto";

import { RateLimiterPostgres, type RateLimiterRes } from "rate-limiter-flexible";
import type { Pool } from "pg";

export type RateLimitScope = "login" | "register" | "reset" | "agent";

export const LOGIN_RATE_LIMIT = { points: 30, duration: 15 * 60 } as const;
export const REGISTER_RATE_LIMIT = { points: 10, duration: 60 * 60 } as const;
// 重置会发信，额度比注册更紧，避免被当作发信机刷。
export const RESET_RATE_LIMIT = { points: 5, duration: 60 * 60 } as const;
// 画布助手每轮都打一次上游、花的是账号自己的额度，所以按账号而不是按 IP 计数。
export const AGENT_RATE_LIMIT = { points: 60, duration: 15 * 60 } as const;

const RATE_LIMITS = { login: LOGIN_RATE_LIMIT, register: REGISTER_RATE_LIMIT, reset: RESET_RATE_LIMIT, agent: AGENT_RATE_LIMIT } as const;

export function normalizeRemoteAddress(address: string) {
    const value = address.trim().toLowerCase();
    return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export function rateLimitKey(secret: string, scope: RateLimitScope, address: string) {
    const normalized = normalizeRemoteAddress(address);
    return `${scope}:${createHmac("sha256", secret).update(normalized).digest("hex")}`;
}

// 按账号计数的键：同一出口 IP 后面的多个账号互不影响。
export function userRateLimitKey(secret: string, scope: RateLimitScope, userId: string) {
    return `${scope}:user:${createHmac("sha256", secret).update(userId).digest("hex")}`;
}

export function createRateLimiter(pool: Pool, scope: RateLimitScope, secret: string) {
    const options = RATE_LIMITS[scope];
    return new RateLimiterPostgres({
        storeClient: pool,
        storeType: "pool",
        tableName: "identity_rate_limits",
        tableCreated: true,
        clearExpiredByTimeout: false,
        keyPrefix: "",
        points: options.points,
        duration: options.duration,
        blockDuration: 0,
        execEvenly: false,
    });
}

export async function consumeRateLimit(limiter: RateLimiterPostgres, secret: string, scope: RateLimitScope, address: string, points = 1): Promise<RateLimiterRes> {
    return limiter.consume(rateLimitKey(secret, scope, address), points);
}

export async function consumeUserRateLimit(limiter: RateLimiterPostgres, secret: string, scope: RateLimitScope, userId: string, points = 1): Promise<RateLimiterRes> {
    return limiter.consume(userRateLimitKey(secret, scope, userId), points);
}

export async function clearExpiredRateLimits(pool: Pool) {
    await pool.query("DELETE FROM identity_rate_limits WHERE expire IS NOT NULL AND expire < $1", [Date.now()]);
}
