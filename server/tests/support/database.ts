import { Pool } from "pg";
import { z } from "zod";

const databaseUrlSchema = z.url().refine((value) => {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1;
});

export function readTestDatabaseUrl(environment: Record<string, string | undefined>) {
    if (environment.NODE_ENV !== "test") throw new Error("Test database requires NODE_ENV=test");
    const result = databaseUrlSchema.safeParse(environment.TEST_DATABASE_URL);
    if (!result.success) throw new Error("Invalid test database configuration");
    if (environment.DATABASE_URL && databaseIdentity(result.data) === databaseIdentity(environment.DATABASE_URL)) {
        throw new Error("Test database must differ from the application database");
    }
    const databaseName = new URL(result.data).pathname.slice(1);
    if (!databaseName.endsWith("_test")) throw new Error("Test database name must end with _test");
    return result.data;
}

export function createTestDatabase(environment: Record<string, string | undefined>) {
    return new Pool({ connectionString: readTestDatabaseUrl(environment) });
}

function databaseIdentity(value: string) {
    const url = new URL(value);
    return [url.protocol, url.hostname.toLowerCase(), url.port || "5432", url.pathname].join("|");
}
