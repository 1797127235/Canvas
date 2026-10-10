import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { Client } from "minio";

import { requireUser } from "./identity/auth-middleware.js";

type MediaOptions = { client?: Client; bucket?: string };

export function createMediaRouter(database: Pool, options: MediaOptions) {
    const router = Router();
    router.use(requireUser(database));
    router.post("/media", (request, response) => uploadMedia(request, response, database, options));
    router.get("/media/:id", (request, response) => readMedia(request, response, database, options));
    router.delete("/media/:id", (request, response) => deleteMedia(request, response, database, options));
    return router;
}

async function uploadMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    if (!options.client || !options.bucket) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const mimeType = request.header("content-type") || "application/octet-stream";
    const id = randomUUID();
    const objectKey = `${response.locals.user.id}/${id}`;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    await options.client.putObject(options.bucket, objectKey, body, body.length, { "Content-Type": mimeType });
    await database.query("INSERT INTO user_media (id, user_id, object_key, mime_type, byte_size) VALUES ($1, $2, $3, $4, $5)", [id, response.locals.user.id, objectKey, mimeType, body.length]);
    return response.status(201).json({ id, mimeType, bytes: body.length });
}

async function readMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    if (!options.client || !options.bucket) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string; mime_type: string }>("SELECT object_key, mime_type FROM user_media WHERE id = $1 AND user_id = $2", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error: { code: "MEDIA_NOT_FOUND", message: "媒体不存在" } });
    const stream = await options.client.getObject(options.bucket, row.object_key);
    response.type(row.mime_type);
    stream.pipe(response);
}

async function deleteMedia(request: Request, response: Response, database: Pool, options: MediaOptions) {
    if (!options.client || !options.bucket) return response.status(503).json({ error: { code: "MEDIA_NOT_CONFIGURED", message: "媒体存储尚未配置" } });
    const result = await database.query<{ object_key: string }>("DELETE FROM user_media WHERE id = $1 AND user_id = $2 RETURNING object_key", [request.params.id, response.locals.user.id]);
    const row = result.rows[0];
    if (row) await options.client.removeObject(options.bucket, row.object_key);
    return response.status(204).end();
}
