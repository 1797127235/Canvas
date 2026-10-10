import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

export type QueryExecutor = {
    query: <T>(text: string, values?: any[]) => Promise<{ rows: T[] }>;
};

export type AccountRecord = {
    id: string;
    email: string;
    passwordHash: string;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
    createdAt: Date;
};

type AccountRow = {
    id: string;
    email: string;
    password_hash: string;
    failed_login_attempts: number;
    locked_until: Date | null;
    created_at: Date;
};

export function createAccountRepository(database: Pool) {
    return {
        create: (email: string, passwordHash: string) => createAccount(database, email, passwordHash),
        findByEmail: (email: string) => findAccount(database, email),
    };
}

export async function createAccount(database: QueryExecutor, email: string, passwordHash: string): Promise<AccountRecord> {
    const result = await database.query<AccountRow>(
        `INSERT INTO users (id, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, password_hash, failed_login_attempts, locked_until, created_at`,
        [randomUUID(), email, passwordHash],
    );
    return mapAccount(result.rows[0]);
}

export async function findAccount(database: QueryExecutor, email: string): Promise<AccountRecord | null> {
    const result = await database.query<AccountRow>(
        `SELECT id, email, password_hash, failed_login_attempts, locked_until, created_at
         FROM users
         WHERE email = $1`,
        [email],
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
}

function mapAccount(row: AccountRow): AccountRecord {
    return {
        id: row.id,
        email: row.email,
        passwordHash: row.password_hash,
        failedLoginAttempts: row.failed_login_attempts,
        lockedUntil: row.locked_until,
        createdAt: row.created_at,
    };
}
