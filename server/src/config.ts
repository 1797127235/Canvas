import { createHmac } from "node:crypto";
import { z } from "zod";

import { readCompactionBudgets } from "./agent/compaction/context.js";

const configSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    HOST: z.string().trim().min(1),
    PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)),
    APP_ORIGIN: z.url(),
    DATABASE_URL: z.url().refine((value) => {
        const url = parseUrl(value);
        return Boolean(url && ["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.length > 1);
    }),
    RATE_LIMIT_SECRET: z.string().refine((value) => Boolean(value.trim())),
    CREDENTIALS_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
    SMTP_HOST: z.string().trim().optional(),
    SMTP_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).optional(),
    SMTP_USER: z.string().trim().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.string().trim().optional(),
    CATALOG_CONFIG_PATH: z.string().trim().optional(),
    AGENT_COMPACTION_BUDGETS: z.string().optional(),
    MINIO_ENDPOINT: z.string().trim().optional(),
    MINIO_PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535)).optional(),
    MINIO_ACCESS_KEY: z.string().trim().optional(),
    MINIO_SECRET_KEY: z.string().trim().optional(),
    MINIO_BUCKET: z.string().trim().optional(),
}).superRefine((config, context) => {
    const url = parseUrl(config.APP_ORIGIN);
    if (!url) {
        context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "Invalid origin" });
        return;
    }
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const validProtocol = ["http:", "https:"].includes(url.protocol) && (config.NODE_ENV === "production" || isLocal);
    if (!validProtocol || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
        context.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "Invalid origin" });
    }
});

export function readConfig(environment: Record<string, string | undefined>) {
    const result = configSchema.safeParse(environment);
    if (!result.success) {
        const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))].join(", ");
        throw new Error(`Invalid server configuration: ${fields}`);
    }
    const config = result.data;
    if (config.CREDENTIALS_ENCRYPTION_KEY && Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, "base64").length !== 32) throw new Error("Invalid server configuration: CREDENTIALS_ENCRYPTION_KEY");
    // 五项齐备才启用密码重置邮件；缺任一项视为未配置，接口明确返回 503 而不是静默失败。
    const mail = config.SMTP_HOST && config.SMTP_PORT && config.SMTP_USER && config.SMTP_PASSWORD && config.MAIL_FROM
        ? { host: config.SMTP_HOST, port: config.SMTP_PORT, user: config.SMTP_USER, password: config.SMTP_PASSWORD, from: config.MAIL_FROM }
        : null;
    const origin = parseUrl(config.APP_ORIGIN);
    if (!origin) throw new Error("Invalid server configuration: APP_ORIGIN");
    return {
        nodeEnv: config.NODE_ENV,
        host: config.HOST,
        port: config.PORT,
        appOrigin: origin.origin,
        databaseUrl: config.DATABASE_URL,
        rateLimitSecret: config.RATE_LIMIT_SECRET,
        credentialsEncryptionKey: config.CREDENTIALS_ENCRYPTION_KEY,
        mediaLinkSecret: createHmac("sha256", config.RATE_LIMIT_SECRET).update("account-media-links").digest("hex"),
        mail,
        catalogConfigPath: config.CATALOG_CONFIG_PATH,
        agentCompactionBudgets: readCompactionBudgets(config.AGENT_COMPACTION_BUDGETS),
        minioEndpoint: config.MINIO_ENDPOINT,
        minioPort: config.MINIO_PORT,
        minioAccessKey: config.MINIO_ACCESS_KEY,
        minioSecretKey: config.MINIO_SECRET_KEY,
        minioBucket: config.MINIO_BUCKET,
    };
}

export type ServerConfig = ReturnType<typeof readConfig>;

function parseUrl(value: string) {
    try {
        return new URL(value);
    } catch {
        return null;
    }
}
