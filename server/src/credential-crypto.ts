import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(secret: string) {
    const key = Buffer.from(secret, "base64");
    if (key.length !== 32) throw new Error("Invalid credentials encryption key");
    return key;
}

export function encryptCredential(value: string, secret: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredential(value: Buffer, secret: string) {
    const key = encryptionKey(secret);
    if (key.length !== 32 || value.length < 28) throw new Error("Invalid credentials encryption data");
    const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}
