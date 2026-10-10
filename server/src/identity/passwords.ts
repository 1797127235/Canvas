import argon2 from "argon2";
import { randomBytes } from "node:crypto";

const ARGON2_OPTIONS: argon2.HashOptions = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
};

export function hashPassword(password: string) {
    return argon2.hash(password, ARGON2_OPTIONS);
}

export function verifyPassword(hash: string, password: string) {
    return argon2.verify(hash, password);
}

let dummyHash: Promise<string> | undefined;

export async function verifyUnknownAccount(password: string) {
    dummyHash ||= hashPassword(randomBytes(32).toString("base64url"));
    await verifyPassword(await dummyHash, password);
}
