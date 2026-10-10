import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { createAccount } from "../src/identity/account-repository.js";
import { createSession, findSession, revokeSession } from "../src/identity/session.js";
import { createTestDatabase } from "./support/database.js";

const database = createTestDatabase(process.env);
const createdAccountIds: string[] = [];
const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

after(async () => {
    for (const id of createdAccountIds) await database.query("DELETE FROM users WHERE id = $1", [id]);
    await database.end();
});

test("persists an account and session in one PostgreSQL transaction", async () => {
    const client = await database.connect();
    const userId = randomUUID();
    try {
        await client.query("BEGIN");
        await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [userId, `${userId}@example.com`, "argon-hash"]);
        const session = await createSession(client, userId, future);
        await client.query("COMMIT");
        createdAccountIds.push(userId);
        assert.equal((await findSession(database, session.sid))?.userId, userId);
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
});

test("rolls back an account and session together", async () => {
    const client = await database.connect();
    const userId = randomUUID();
    try {
        await client.query("BEGIN");
        await client.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [userId, `${userId}@example.com`, "argon-hash"]);
        const session = await createSession(client, userId, future);
        await client.query("ROLLBACK");
        assert.equal(await findSession(database, session.sid), null);
        const account = await database.query("SELECT id FROM users WHERE id = $1", [userId]);
        assert.equal(account.rowCount, 0);
    } finally {
        client.release();
    }
});

test("keeps a valid session readable through a new pool after the original pool closes", async () => {
    const userId = randomUUID();
    const account = await createAccount(database, `${userId}@example.com`, "argon-hash");
    createdAccountIds.push(account.id);
    const session = await createSession(database, account.id, future);
    const reopened = createTestDatabase(process.env);
    try {
        assert.equal((await findSession(reopened, session.sid))?.userId, account.id);
    } finally {
        await reopened.end();
    }
});

test("makes concurrent revocation idempotent and leaves no readable session", async () => {
    const userId = randomUUID();
    const account = await createAccount(database, `${userId}@example.com`, "argon-hash");
    createdAccountIds.push(account.id);
    const session = await createSession(database, account.id, future);
    await Promise.all([revokeSession(database, session.sid), revokeSession(database, session.sid)]);
    assert.equal(await findSession(database, session.sid), null);
});

test("revoking a session makes the old SID unreadable", async () => {
    const userId = randomUUID();
    const account = await createAccount(database, `${userId}@example.com`, "argon-hash");
    createdAccountIds.push(account.id);
    const session = await createSession(database, account.id, future);
    assert.ok(await findSession(database, session.sid));
    await revokeSession(database, session.sid);
    assert.equal(await findSession(database, session.sid), null);
});

test("does not load a session after its fixed expiration", async () => {
    const userId = randomUUID();
    const account = await createAccount(database, `${userId}@example.com`, "argon-hash");
    createdAccountIds.push(account.id);
    const session = await createSession(database, account.id, new Date("2000-01-01T00:00:00Z"));
    assert.equal(await findSession(database, session.sid), null);
});
