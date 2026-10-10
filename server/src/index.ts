import { Client } from "minio";

import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { clearExpiredIdentityData } from "./identity/cleanup.js";
import { createLoginRouter } from "./identity/login.js";
import { createRateLimiter } from "./identity/rate-limit.js";
import { createRegisterRouter } from "./identity/register.js";
import { createSessionRouter } from "./identity/session-routes.js";
import { loadCatalog } from "./catalog/catalog.js";
import { createCatalogRouter } from "./catalog.js";
import { createCredentialRouter } from "./credentials.js";
import { createWorkspaceRouter } from "./workspace.js";
import { createMediaRouter } from "./media.js";
import { createGenerationRouter } from "./generation.js";

async function start() {
    const config = readConfig(process.env);
    const database = createDatabase(config);
    try {
        // 启动时验证数据库/schema 并清理过期记录；认证拒绝过期凭证不依赖清理。
        await clearExpiredIdentityData(database.pool);
        const secret = config.rateLimitSecret;
        const dependencies = { database: database.pool, rateLimitSecret: secret, secureCookie: config.nodeEnv === "production" };
        const catalog = await loadCatalog(config.catalogConfigPath, config.nodeEnv === "production");
        const minio = config.minioEndpoint && config.minioPort && config.minioAccessKey && config.minioSecretKey && config.minioBucket
            ? { client: new Client({ endPoint: config.minioEndpoint, port: config.minioPort, useSSL: config.nodeEnv === "production", accessKey: config.minioAccessKey, secretKey: config.minioSecretKey }), bucket: config.minioBucket }
            : {};
        const apiRouter = createSessionRouter(database.pool, dependencies.secureCookie);
        apiRouter.use(createRegisterRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "register", secret) }));
        apiRouter.use(createLoginRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "login", secret) }));
        apiRouter.use(createCatalogRouter(catalog));
        apiRouter.use(createCredentialRouter(database.pool, { encryptionKey: config.credentialsEncryptionKey }));
        apiRouter.use(createWorkspaceRouter(database.pool));
        apiRouter.use(createMediaRouter(database.pool, minio));
        apiRouter.use(createGenerationRouter(database.pool, { catalog, encryptionKey: config.credentialsEncryptionKey }));
        const server = createApp({ appOrigin: config.appOrigin, apiRouter }).listen(config.port, config.host);
        let closing = false;
        const close = () => {
            if (closing) return;
            closing = true;
            server.close(() => {
                void database.close().catch(() => { console.error("Database shutdown failed"); process.exitCode = 1; });
            });
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
        server.on("error", () => {
            console.error("Server failed to listen");
            process.exitCode = 1;
            close();
        });
    } catch (error) {
        await database.close();
        throw error;
    }
}

void start().catch(() => {
    console.error("Server startup failed: check configuration and database");
    process.exitCode = 1;
});
