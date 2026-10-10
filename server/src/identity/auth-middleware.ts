import type { Request, RequestHandler } from "express";
import type { Pool } from "pg";

import { hashSid, readSessionId } from "./session.js";

export type CurrentUser = { id: string; email: string };

export async function readCurrentUser(request: Pick<Request, "headers">, database: Pool) {
    const sid = readSessionId(request.headers.cookie);
    if (!sid) return null;
    const result = await database.query<{ id: string; email: string; expires_at: Date }>(
        `SELECT users.id, users.email, sessions.expires_at
         FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.sid_hash = $1 AND sessions.expires_at > CURRENT_TIMESTAMP`,
        [hashSid(sid)],
    );
    const row = result.rows[0];
    return row ? { user: { id: row.id, email: row.email }, expiresAt: row.expires_at.toISOString() } : null;
}

export function requireUser(database: Pool): RequestHandler {
    return async (request, response, next) => {
        const session = await readCurrentUser(request, database);
        if (!session) return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "请先登录" } });
        response.locals.user = session.user;
        return next();
    };
}
