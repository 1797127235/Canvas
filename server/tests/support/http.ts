import { once } from "node:events";
import { createServer, type Server } from "node:http";

import type { Express } from "express";

export type TestServer = {
    server: Server;
    baseUrl: string;
    close: () => Promise<void>;
};

export async function startTestServer(app: Express): Promise<TestServer> {
    const server = createServer(app).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
        await closeServer(server);
        throw new Error("Test server did not expose a TCP address");
    }
    return {
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server),
    };
}

export async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<{ response: Response; body: T | null }> {
    const response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers: { accept: "application/json", ...init?.headers },
    });
    const text = await response.text();
    return { response, body: text ? (JSON.parse(text) as T) : null };
}

async function closeServer(server: Server) {
    if (!server.listening) return;
    server.close();
    await once(server, "close");
}
