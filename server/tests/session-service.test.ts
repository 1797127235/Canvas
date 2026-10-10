import assert from "node:assert/strict";
import { test } from "node:test";

import {
    createSession,
    findSession,
    hashSid,
    readSessionId,
    revokeSession,
    serializeClearedSessionCookie,
    serializeSessionCookie,
    SESSION_TTL_SECONDS,
} from "../src/identity/session.js";

test("creates a random session and persists only its digest", async () => {
    const calls: Array<{ text: string; values: any[] }> = [];
    const database = {
        query: async <T>(text: string, values: any[] = []) => {
            calls.push({ text, values });
            return { rows: [] as T[] };
        },
    };
    const now = new Date("2026-01-01T00:00:00Z");
    const session = await createSession(database, "user-id", now);

    assert.equal(session.sid.length, 32);
    assert.equal(session.sidHash.length, 32);
    assert.deepEqual(session.sidHash, hashSid(session.sid));
    assert.equal(session.expiresAt.getTime(), now.getTime() + SESSION_TTL_SECONDS * 1000);
    assert.deepEqual(calls[0].values, [session.sidHash, "user-id", session.expiresAt]);
    assert.match(calls[0].text, /INSERT INTO sessions/);
});

test("loads an active session using the SID digest and rejects missing rows", async () => {
    const sid = Buffer.alloc(32, 7);
    const calls: Array<{ text: string; values: any[] }> = [];
    const database = {
        query: async <T>(text: string, values: any[] = []) => {
            calls.push({ text, values });
            return { rows: [{ user_id: "user-id", expires_at: new Date("2026-01-08T00:00:00Z") }] as T[] };
        },
    };
    const session = await findSession(database, sid);
    assert.equal(session?.userId, "user-id");
    assert.deepEqual(calls[0].values, [hashSid(sid)]);
    assert.match(calls[0].text, /expires_at > CURRENT_TIMESTAMP/);
});

test("revokes by digest and parses only valid 32-byte cookies", async () => {
    const sid = Buffer.alloc(32, 9);
    const calls: Array<{ text: string; values: any[] }> = [];
    const database = {
        query: async (text: string, values: any[] = []) => {
            calls.push({ text, values });
            return { rows: [] };
        },
    };
    await revokeSession(database, sid);
    assert.deepEqual(calls[0].values, [hashSid(sid)]);
    assert.match(serializeSessionCookie(sid, true), new RegExp(`infinite_canvas_session=${sid.toString("base64url")}`));
    assert.deepEqual(readSessionId(`infinite_canvas_session=${sid.toString("base64url")}`), sid);
    assert.equal(readSessionId("infinite_canvas_session=invalid"), null);
    assert.equal(readSessionId(undefined), null);
});

test("serializes fixed secure cookies and a clearing cookie", () => {
    const sid = Buffer.alloc(32, 1);
    const cookie = serializeSessionCookie(sid, true);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Max-Age=604800/);
    assert.match(serializeClearedSessionCookie(false), /Max-Age=0/);
});
