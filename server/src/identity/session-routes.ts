import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";

import { readCurrentUser } from "./auth-middleware.js";
import { readSessionId, revokeSession, serializeClearedSessionCookie } from "./session.js";

export function createSessionRouter(database: Pool, secureCookie: boolean) {
    const router = Router();
    router.get("/session", (request, response) => currentSession(request, response, database));
    router.delete("/session", (request, response) => logout(request, response, database, secureCookie));
    return router;
}

async function currentSession(request: Request, response: Response, database: Pool) {
    const session = await readCurrentUser(request, database);
    if (!session) return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "请先登录" } });
    return response.status(200).json(session);
}

async function logout(request: Request, response: Response, database: Pool, secureCookie: boolean) {
    const sid = readSessionId(request.headers.cookie);
    if (sid) await revokeSession(database, sid);
    response.setHeader("Set-Cookie", serializeClearedSessionCookie(secureCookie));
    return response.status(204).end();
}
