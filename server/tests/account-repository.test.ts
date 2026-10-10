import assert from "node:assert/strict";
import { test } from "node:test";

import { createAccount, findAccount } from "../src/identity/account-repository.js";

test("creates accounts with parameterized values and maps returned fields", async () => {
    const calls: Array<{ text: string; values: any[] }> = [];
    const database = {
        query: async <T>(text: string, values: any[] = []) => {
            calls.push({ text, values });
            return {
                rows: [
                    {
                        id: "user-id",
                        email: "person@example.com",
                        password_hash: "argon-hash",
                        failed_login_attempts: 0,
                        locked_until: null,
                        created_at: new Date("2026-01-01T00:00:00Z"),
                    },
                ] as T[],
            };
        },
    };

    const account = await createAccount(database, "person@example.com", "argon-hash");
    assert.equal(account.email, "person@example.com");
    assert.equal(account.passwordHash, "argon-hash");
    assert.match(calls[0].text, /VALUES \(\$1, \$2, \$3\)/);
    assert.deepEqual(calls[0].values.slice(1), ["person@example.com", "argon-hash"]);
});

test("returns null when the normalized email is absent", async () => {
    const database = {
        query: async () => ({ rows: [] }),
    };
    assert.equal(await findAccount(database, "missing@example.com"), null);
});
