import { createHash, randomBytes } from "node:crypto";

import { parse, serialize } from "cookie";

import type { QueryExecutor } from "./account-repository.js";

export const SESSION_COOKIE_NAME = "infinite_canvas_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_SID_BYTES = 32;

type SessionRow = {
    user_id: string;
    expires_at: Date;
};

export type SessionRecord = {
    sid: Buffer;
    sidHash: Buffer;
    userId: string;
    expiresAt: Date;
};

export async function createSession(database: QueryExecutor, userId: string, now = new Date()): Promise<SessionRecord> {
    const sid = randomBytes(SESSION_SID_BYTES);
    const sidHash = hashSid(sid);
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    await database.query(
        `INSERT INTO sessions (sid_hash, user_id, expires_at)
         VALUES ($1, $2, $3)`,
        [sidHash, userId, expiresAt],
    );
    return { sid, sidHash, userId, expiresAt };
}

export async function findSession(database: QueryExecutor, sid: Buffer): Promise<{ userId: string; expiresAt: Date } | null> {
    const result = await database.query<SessionRow>(
        `SELECT user_id, expires_at
         FROM sessions
         WHERE sid_hash = $1 AND expires_at > CURRENT_TIMESTAMP`,
        [hashSid(sid)],
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, expiresAt: row.expires_at } : null;
}

export async function revokeSession(database: QueryExecutor, sid: Buffer): Promise<void> {
    await database.query("DELETE FROM sessions WHERE sid_hash = $1", [hashSid(sid)]);
}

export function hashSid(sid: Buffer) {
    return createHash("sha256").update(sid).digest();
}

export function serializeSessionCookie(sid: Buffer, secure: boolean) {
    return serialize(SESSION_COOKIE_NAME, sid.toString("base64url"), {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
    });
}

export function serializeClearedSessionCookie(secure: boolean) {
    return serialize(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: 0,
    });
}

export function readSessionId(cookieHeader: string | undefined) {
    if (!cookieHeader) return null;
    const value = parse(cookieHeader)[SESSION_COOKIE_NAME];
    if (!value) return null;
    try {
        const sid = Buffer.from(value, "base64url");
        return sid.length === SESSION_SID_BYTES ? sid : null;
    } catch {
        return null;
    }
}
