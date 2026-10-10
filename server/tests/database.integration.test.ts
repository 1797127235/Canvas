import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { createAccount, findAccount } from "../src/identity/account-repository.js";
import { createTestDatabase } from "./support/database.js";

const database = createTestDatabase(process.env);
const createdAccountIds: string[] = [];

after(async () => {
    for (const id of createdAccountIds) await database.query("DELETE FROM users WHERE id = $1", [id]);
    await database.end();
});

test("persists and reads a parameterized account in the isolated test database", async () => {
    const email = `${randomUUID()}@example.com`;
    const account = await createAccount(database, email, "argon-hash");
    createdAccountIds.push(account.id);
    const loaded = await findAccount(database, email);

    assert.equal(loaded?.id, account.id);
    assert.equal(loaded?.email, email);
    assert.equal(loaded?.passwordHash, "argon-hash");
});

test("enforces normalized email uniqueness at the database boundary", async () => {
    const email = `${randomUUID()}@example.com`;
    const account = await createAccount(database, email, "first-hash");
    createdAccountIds.push(account.id);
    await assert.rejects(() => createAccount(database, email, "second-hash"), { code: "23505" });
});
