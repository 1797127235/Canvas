import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";

import { createApp } from "../src/app.js";
import { createCredentialRouter, normalizeBaseUrl } from "../src/credentials.js";
import { decryptCredential, encryptCredential } from "../src/credential-crypto.js";
import { hashSid } from "../src/identity/session.js";
import { startTestServer } from "./support/http.js";

const origin = "http://localhost:3000";
const encryptionKey = randomBytes(32).toString("base64");
const sid = Buffer.alloc(32, 9);
const userId = randomUUID();
const cookie = `infinite_canvas_session=${sid.toString("base64url")}`;

// 只实现凭据路由用到的那几条 SQL，避免为跑用例起真实数据库。
function credentialDatabase() {
    const rows = new Map<string, { encrypted_api_key: Buffer; base_url: string | null }>();
    const query = async (sql: string, values: unknown[]) => {
        if (sql.includes("FROM sessions")) {
            assert.ok((values[0] as Buffer).equals(hashSid(sid)));
            return { rows: [{ id: userId, email: "a@example.com", expires_at: new Date("2099-01-01") }] };
        }
        if (sql.startsWith("SELECT encrypted_api_key, base_url")) {
            const row = rows.get(values[0] as string);
            return { rows: row ? [row] : [] };
        }
        if (sql.startsWith("INSERT INTO user_credentials")) {
            const existing = rows.get(values[0] as string);
            rows.set(values[0] as string, { encrypted_api_key: values[1] as Buffer, base_url: values.length > 2 ? values[2] as string | null : existing?.base_url ?? null });
            return { rows: [] };
        }
        if (sql.startsWith("UPDATE user_credentials")) {
            const row = rows.get(values[0] as string);
            if (!row) return { rows: [], rowCount: 0 };
            row.base_url = values[1] as string | null;
            return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("DELETE FROM user_credentials")) {
            rows.delete(values[0] as string);
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected query: ${sql}`);
    };
    return { rows, database: { query } as unknown as Pool };
}

const put = (baseUrl: string, body: Record<string, string>) => fetch(`${baseUrl}/api/credentials`, {
    method: "PUT", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(body),
});
const read = async (baseUrl: string) => {
    const response = await fetch(`${baseUrl}/api/credentials`, { headers: { cookie } });
    return { status: response.status, body: await response.json() as { configured: boolean; masked: string | null; baseUrl: string | null } };
};

test("accepts only normalized http(s) upstream roots with an explicit path prefix", () => {
    assert.equal(normalizeBaseUrl("  https://api.example.com/v1/  "), "https://api.example.com/v1");
    assert.equal(normalizeBaseUrl("https://API.EXAMPLE.COM:443/v1"), "https://api.example.com/v1");
    assert.equal(normalizeBaseUrl("http://127.0.0.1:8000/openai/v1"), "http://127.0.0.1:8000/openai/v1");
    for (const value of ["", "   ", "not a url", "ftp://api.example.com/v1", "https://api.example.com", "https://api.example.com/", "https://key@api.example.com/v1", "https://api.example.com/v1?x=1", "https://api.example.com/v1#x"]) {
        assert.equal(normalizeBaseUrl(value), null, value);
    }
});

test("saves the account upstream address independently from the API key", async () => {
    const { rows, database } = credentialDatabase();
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createCredentialRouter(database, { encryptionKey }) }));
    try {
        // 地址依附于 Key：没有 Key 时先存地址会被拒。
        assert.equal((await put(api.baseUrl, { baseUrl: "https://api.example.com/v1" })).status, 409);
        // 非法地址在保存时就拦下，不留到模型发现阶段才报错。
        const invalid = await put(api.baseUrl, { apiKey: "account-key", baseUrl: "https://api.example.com" });
        assert.equal(invalid.status, 422);
        assert.equal((await invalid.json() as { error: { message: string } }).error.message.includes("路径前缀"), true);

        assert.equal((await put(api.baseUrl, { apiKey: "account-key" })).status, 204);
        assert.deepEqual(await read(api.baseUrl), { status: 200, body: { configured: true, masked: "acco•••-key", baseUrl: null } });
        assert.equal(decryptCredential(rows.get(userId)!.encrypted_api_key, encryptionKey), "account-key");

        assert.equal((await put(api.baseUrl, { baseUrl: "https://upstream.example.com/v1/" })).status, 204);
        assert.equal((await read(api.baseUrl)).body.baseUrl, "https://upstream.example.com/v1");
        // 轮换 Key 不动已配置的上游地址。
        assert.equal((await put(api.baseUrl, { apiKey: "rotated-key" })).status, 204);
        assert.equal((await read(api.baseUrl)).body.baseUrl, "https://upstream.example.com/v1");
        assert.equal(decryptCredential(rows.get(userId)!.encrypted_api_key, encryptionKey), "rotated-key");
        // Key 和地址一起提交时两个都生效。
        assert.equal((await put(api.baseUrl, { apiKey: "final-key", baseUrl: "https://other.example.com/v1" })).status, 204);
        assert.equal((await read(api.baseUrl)).body.baseUrl, "https://other.example.com/v1");
        assert.equal(decryptCredential(rows.get(userId)!.encrypted_api_key, encryptionKey), "final-key");
        // 空串表示回落到部署目录里的默认上游。
        assert.equal((await put(api.baseUrl, { baseUrl: "" })).status, 204);
        assert.equal((await read(api.baseUrl)).body.baseUrl, null);
        // 两个字段都不给没有意义。
        assert.equal((await put(api.baseUrl, {})).status, 422);

        const unauthorized = await fetch(`${api.baseUrl}/api/credentials`, { headers: { origin, cookie: "infinite_canvas_session=none" } });
        assert.equal(unauthorized.status, 401);
    } finally {
        await api.close();
    }
});
