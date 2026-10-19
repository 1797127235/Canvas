import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { randomFillSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { Pool } from "pg";
import sharp from "sharp";

import { createApp } from "../src/app.js";
import { createCanvasPreview, createMediaRouter } from "../src/media.js";
import { hashSid } from "../src/identity/session.js";
import { startTestServer } from "./support/http.js";

const origin = "http://localhost:3000";
const execFileAsync = promisify(execFile);

async function createVideoFixture(path: string) {
    await execFileAsync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16:d=0.2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", path]);
    return readFile(path);
}

test("canvas preview consumes large sharp output without stalling", async () => {
    const raw = randomFillSync(Buffer.alloc(512 * 512 * 3));
    const source = await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    const preview = await Promise.race([
        createCanvasPreview(Readable.from(source), 512),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("preview generation stalled")), 2_000)),
    ]);
    assert.ok(preview.length > 65_536);
});

test("account media streams raw uploads and isolates Range, HEAD and stale-account operations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "account-media-"));
    const sidA = Buffer.alloc(32, 1), sidB = Buffer.alloc(32, 2);
    const userA = randomUUID(), userB = randomUUID();
    const headers = (sid: Buffer) => ({ cookie: `infinite_canvas_session=${sid.toString("base64url")}` });
    const files = new Map<string, { user: string; object_key: string; mime_type: string; byte_size: number }>();
    const database = { query: async (sql: string, values: unknown[]) => {
        if (sql.includes("FROM sessions")) {
            const id = (values[0] as Buffer).equals(hashSid(sidA)) ? userA : userB;
            return { rows: [{ id, email: "test@example.com", expires_at: new Date("2099-01-01") }] };
        }
        if (sql.includes("INSERT INTO user_media")) {
            files.set(values[0] as string, { user: values[1] as string, object_key: values[2] as string, mime_type: values[3] as string, byte_size: values[4] as number });
            return { rows: [] };
        }
        const file = files.get(values[0] as string);
        if (sql.startsWith("SELECT") && sql.includes("FROM user_media WHERE id = $1")) {
            return { rows: file && (!sql.includes("AND user_id = $2") || file.user === values[1]) ? [file] : [] };
        }
        if (file?.user !== values[1]) return { rows: [] };
        if (sql.startsWith("DELETE")) files.delete(values[0] as string);
        return { rows: [file] };
    } } as unknown as Pool;
    const api = await startTestServer(createApp({ appOrigin: origin, apiRouter: createMediaRouter(database, { directory }, "test-media-link-secret") }));
    try {
        const bytes = new Uint8Array([0, 255, 17, 128, 64]);
        const upload = await fetch(`${api.baseUrl}/api/media`, { method: "POST", headers: { ...headers(sidA), origin, "content-type": "video/mp4" }, body: bytes });
        assert.equal(upload.status, 201);
        const { id } = await upload.json() as { id: string };
        const url = `${api.baseUrl}/api/media/${id}`;
        assert.equal((await fetch(url, { headers: headers(sidB) })).status, 404);
        const full = await fetch(url, { headers: headers(sidA) });
        assert.equal(full.headers.get("accept-ranges"), "bytes");
        assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
        const partial = await fetch(url, { headers: { ...headers(sidA), range: "bytes=1-3" } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get("content-range"), "bytes 1-3/5");
        assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), bytes.slice(1, 4));
        assert.equal((await fetch(url, { headers: { ...headers(sidA), range: "bytes=100-" } })).status, 416);
        const head = await fetch(url, { method: "HEAD", headers: headers(sidA) });
        assert.equal(head.headers.get("content-length"), "5");
        assert.equal((await head.arrayBuffer()).byteLength, 0);
        const stale = await fetch(`${api.baseUrl}/api/media`, { method: "POST", headers: { ...headers(sidB), origin, "x-account-id": userA, "content-type": "image/png" }, body: bytes });
        assert.equal(stale.status, 409);
        const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
        const imageUpload = await fetch(`${api.baseUrl}/api/media`, { method: "POST", headers: { ...headers(sidA), origin, "content-type": "image/png" }, body: imageBytes });
        assert.equal(imageUpload.status, 201);
        const { id: imageId } = await imageUpload.json() as { id: string };
        const { signedMediaUrl } = await import("../src/media.js");
        const signedUrl = new URL(signedMediaUrl(api.baseUrl, "test-media-link-secret", imageId));
        const signedImage = await fetch(signedUrl);
        assert.equal(signedImage.status, 200);
        assert.deepEqual(Buffer.from(await signedImage.arrayBuffer()), imageBytes);
        const rejectedSignedImage = await fetch(new URL(signedMediaUrl(api.baseUrl, "wrong-secret", imageId)));
        assert.equal(rejectedSignedImage.status, 401);
        const preview = await fetch(`${api.baseUrl}/api/media/${imageId}/preview`, { headers: headers(sidA) });
        assert.equal(preview.status, 200);
        assert.equal(preview.headers.get("content-type")?.split(";", 1)[0], "image/webp");
        assert.ok((await preview.arrayBuffer()).byteLength > 0);
        assert.equal(preview.headers.get("cache-control"), "private, no-cache");
        // 默认取最小档；客户端会带 ?w= 上报实际需要显示的最长边。
        assert.match(preview.headers.get("etag") || "", /^"[0-9a-f-]+-canvas-preview-v2-512"$/);
        const cachedPreview = await fetch(`${api.baseUrl}/api/media/${imageId}/preview`, { headers: { ...headers(sidA), "if-none-match": preview.headers.get("etag") || "" } });
        assert.equal(cachedPreview.status, 304);
        // 1020 需要 1024 档，超上限时封顶到 2048，两个档位各有独立 ETag（不会与 512 档串缓）。
        const tieredPreview = await fetch(`${api.baseUrl}/api/media/${imageId}/preview?w=1020`, { headers: headers(sidA) });
        assert.equal(tieredPreview.status, 200);
        assert.match(tieredPreview.headers.get("etag") || "", /^"[0-9a-f-]+-canvas-preview-v2-1024"$/);
        const cappedPreview = await fetch(`${api.baseUrl}/api/media/${imageId}/preview?w=5000`, { headers: headers(sidA) });
        assert.equal(cappedPreview.status, 200);
        assert.match(cappedPreview.headers.get("etag") || "", /^"[0-9a-f-]+-canvas-preview-v2-2048"$/);
        const stalePreviewEtag = await fetch(`${api.baseUrl}/api/media/${imageId}/preview?w=1020`, { headers: { ...headers(sidA), "if-none-match": preview.headers.get("etag") || "" } });
        assert.equal(stalePreviewEtag.status, 200);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${imageId}/preview`, { headers: headers(sidB) })).status, 404);
        const videoBytes = await createVideoFixture(join(directory, "poster-fixture.mp4"));
        const videoUpload = await fetch(`${api.baseUrl}/api/media`, { method: "POST", headers: { ...headers(sidA), origin, "content-type": "video/mp4" }, body: videoBytes });
        assert.equal(videoUpload.status, 201);
        const { id: videoId } = await videoUpload.json() as { id: string };
        const poster = await fetch(`${api.baseUrl}/api/media/${videoId}/poster`, { headers: headers(sidA) });
        assert.equal(poster.status, 200);
        assert.equal(poster.headers.get("content-type")?.split(";", 1)[0], "image/webp");
        assert.ok((await poster.arrayBuffer()).byteLength > 0);
        assert.equal(poster.headers.get("cache-control"), "private, no-cache");
        assert.match(poster.headers.get("etag") || "", /^"[0-9a-f-]+-video-poster-canvas-v1"$/);
        const cachedPoster = await fetch(`${api.baseUrl}/api/media/${videoId}/poster`, { headers: { ...headers(sidA), "if-none-match": poster.headers.get("etag") || "" } });
        assert.equal(cachedPoster.status, 304);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${videoId}/poster`, { headers: headers(sidB) })).status, 404);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${imageId}/poster`, { headers: headers(sidA) })).status, 415);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${videoId}`, { method: "DELETE", headers: { ...headers(sidA), origin } })).status, 204);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${videoId}/poster`, { headers: headers(sidA) })).status, 404);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${imageId}`, { method: "DELETE", headers: { ...headers(sidA), origin } })).status, 204);
        assert.equal((await fetch(`${api.baseUrl}/api/media/${imageId}/preview`, { headers: headers(sidA) })).status, 404);

        const json = '{"raw":true}';
        const jsonUpload = await fetch(`${api.baseUrl}/api/media`, { method: "POST", headers: { ...headers(sidA), origin, "content-type": "application/json" }, body: json });
        assert.equal(jsonUpload.status, 201);
        const { id: jsonId } = await jsonUpload.json() as { id: string };
        assert.equal(await (await fetch(`${api.baseUrl}/api/media/${jsonId}`, { headers: headers(sidA) })).text(), json);
        assert.equal((await fetch(url, { method: "DELETE", headers: { ...headers(sidB), origin } })).status, 204);
        assert.equal((await fetch(url, { headers: headers(sidA) })).status, 200);
        assert.equal((await fetch(url, { method: "DELETE", headers: { ...headers(sidA), origin } })).status, 204);
        assert.equal((await fetch(url, { headers: headers(sidA) })).status, 404);
    } finally {
        await api.close();
        await rm(directory, { recursive: true, force: true });
    }
});
