import { createHmac } from "node:crypto";

import { RateLimiterPostgres, type RateLimiterRes } from "rate-limiter-flexible";
import type { Pool } from "pg";

export const LOGIN_RATE_LIMIT = { points: 30, duration: 15 * 60 } as const;
export const REGISTER_RATE_LIMIT = { points: 10, duration: 60 * 60 } as const;

export function normalizeRemoteAddress(address: string) {
    const value = address.trim().toLowerCase();
    return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export function rateLimitKey(secret: string, scope: "login" | "register", address: string) {
    const normalized = normalizeRemoteAddress(address);
    return `${scope}:${createHmac("sha256", secret).update(normalized).digest("hex")}`;
}

export function createRateLimiter(pool: Pool, scope: "login" | "register", secret: string) {
    const options = scope === "login" ? LOGIN_RATE_LIMIT : REGISTER_RATE_LIMIT;
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

export async function consumeRateLimit(limiter: RateLimiterPostgres, secret: string, scope: "login" | "register", address: string, points = 1): Promise<RateLimiterRes> {
    return limiter.consume(rateLimitKey(secret, scope, address), points);
}

export async function clearExpiredRateLimits(pool: Pool) {
    await pool.query("DELETE FROM identity_rate_limits WHERE expire IS NOT NULL AND expire < $1", [Date.now()]);
}
