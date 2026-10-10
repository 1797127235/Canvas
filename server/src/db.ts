import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { ServerConfig } from "./config.js";

export type Database = {
    pool: Pool;
    close: () => Promise<void>;
};

export function createDatabase(config: ServerConfig): Database {
    const pool = new Pool({ connectionString: config.databaseUrl });
    pool.on("error", () => undefined);
    return { pool, close: () => pool.end() };
}

export async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await callback(client);
        await client.query("COMMIT");
        return result;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
    } finally {
        client.release();
    }
}

export function query<T extends QueryResultRow>(pool: Pool, text: string, values: any[] = []): Promise<QueryResult<T>> {
    return pool.query<T>(text, values);
}
