import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import express, { type Router } from "express";

import { createApp } from "../src/app.js";
import { initLogging } from "../src/log.js";
import { startTestServer, type TestServer } from "./support/http.js";

const origin = "http://localhost:3000";

type LogLine = Record<string, unknown> & { scope: string };

function capture(): LogLine[] {
    const lines: LogLine[] = [];
    initLogging(new Writable({
        write(chunk, _encoding, callback) {
            lines.push(JSON.parse(String(chunk)) as LogLine);
            callback();
        },
    }));
    return lines;
}

function stubRouter(): Router {
    const router = express.Router();
    router.use((_request, response, next) => {
        response.locals.user = { id: "user-1" };
        next();
    });
    router.post("/echo", (request, response) => response.json({ ok: true, echo: request.body }));
    router.get("/models", (_request, response) => response.json({ models: [{ id: "m-1" }] }));
    router.post("/media/echo", (request, response) => response.json({ ok: true }));
    return router;
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
    const lines = capture();
    const server: TestServer = await startTestServer(createApp({ appOrigin: origin, apiRouter: stubRouter() }));
    try {
        await run(server.baseUrl);
        await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
        await server.close();
    }
    return lines.filter((line) => line.scope === "http" && line.msg === "request");
}

test("每个 /api 请求输出一行审计日志，请求体脱敏、账号与响应体齐全", async () => {
    const lines = await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/echo`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ password: "secret", apiKey: "sk-abcdefghijklmnop", prompt: "画一只猫" }),
        });
        assert.equal(response.status, 200);
    });
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.method, "POST");
    assert.equal(line.path, "/api/echo");
    assert.equal(line.status, 200);
    assert.equal(line.userId, "user-1");
    assert.ok(typeof line.durationMs === "number");
    const reqBody = line.reqBody as Record<string, unknown>;
    assert.equal(reqBody.password, "[redacted]");
    assert.equal(reqBody.apiKey, "sk-abc…(len 19)");
    assert.equal(reqBody.prompt, "画一只猫");
    assert.deepEqual(line.resBody, { ok: true, echo: { password: "[redacted]", apiKey: "sk-abc…(len 19)", prompt: "画一只猫" } });
});

test("超长请求体和响应体按上限截断", async () => {
    const lines = await withServer(async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/echo`, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ prompt: "长".repeat(20000) }),
        });
        assert.equal(response.status, 200);
    });
    const [line] = lines;
    const reqBody = line.reqBody as string;
    const resBody = line.resBody as string;
    assert.ok(typeof reqBody === "string" && reqBody.includes("[truncated"));
    assert.ok(reqBody.length < 20000);
    assert.ok(typeof resBody === "string" && resBody.includes("[truncated"));
});

test("健康检查不记日志，媒体请求只记元信息，伪造来源的 403 也会记录", async () => {
    const lines = await withServer(async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
        const media = await fetch(`${baseUrl}/api/media/echo`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: "secret" }) });
        assert.equal(media.status, 200);
        const rejected = await fetch(`${baseUrl}/api/echo`, { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
        assert.equal(rejected.status, 403);
    });
    assert.ok(!lines.some((line) => line.path === "/api/health"));
    const mediaLine = lines.find((line) => line.path === "/api/media/echo");
    assert.equal(mediaLine?.media, true);
    assert.equal(mediaLine?.reqBody, undefined);
    assert.equal(mediaLine?.resBody, undefined);
    const rejectedLine = lines.find((line) => line.path === "/api/echo");
    assert.equal(rejectedLine?.status, 403);
});
