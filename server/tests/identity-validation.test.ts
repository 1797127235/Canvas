import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeEmail, passwordSchema } from "../src/identity/schemas.js";
import { hashPassword, verifyPassword } from "../src/identity/passwords.js";

test("normalizes only email surrounding whitespace and case", () => {
    assert.equal(normalizeEmail("  User@Example.com  "), "user@example.com");
    assert.equal(normalizeEmail("User.Name+tag@example.com"), "user.name+tag@example.com");
});

test("accepts password boundaries and printable ASCII", () => {
    assert.equal(passwordSchema.safeParse("Abc123!@").success, true);
    assert.equal(passwordSchema.safeParse("!".repeat(128)).success, true);
    assert.equal(passwordSchema.safeParse("a".repeat(7)).success, false);
    assert.equal(passwordSchema.safeParse("a".repeat(129)).success, false);
    assert.equal(passwordSchema.safeParse("中文密码123").success, false);
    assert.equal(passwordSchema.safeParse("password with space").success, false);
    assert.equal(passwordSchema.safeParse("password\n").success, false);
});

test("hashes and verifies passwords without storing the plaintext", async () => {
    const password = "Correct!Password123";
    const hash = await hashPassword(password);
    assert.notEqual(hash, password);
    assert.match(hash, /^\$argon2id\$/);
    assert.equal(await verifyPassword(hash, password), true);
    assert.equal(await verifyPassword(hash, "Wrong!Password123"), false);
});
