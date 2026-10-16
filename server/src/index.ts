import { readFile } from "node:fs/promises";
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
import { createMediaRouter, clearUnusedMedia } from "./media.js";
import { createGenerationRouter } from "./generation.js";
import { logError } from "./log.js";

async function start() {
    const config = readConfig(process.env);
    const database = createDatabase(config);
    try {
        // 启动时验证数据库/schema 并清理过期记录；认证拒绝过期凭证不依赖清理。
        for (const file of ["003-workspace-credentials-media.sql", "004-generation-tasks.sql", "005-generation-history.sql", "006-generation-sdk-operations.sql", "007-image-generation-tasks.sql", "008-media-references.sql", "009-credential-base-url.sql"]) {
            await database.pool.query(await readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"));
        }
        await clearExpiredIdentityData(database.pool);
        const secret = config.rateLimitSecret;
        // 会话 Cookie 的 Secure 标志跟随实际访问协议：HTTP 部署下浏览器不回传 Secure Cookie。
        const dependencies = { database: database.pool, rateLimitSecret: secret, secureCookie: config.appOrigin.startsWith("https:") };
        const catalog = await loadCatalog(config.catalogConfigPath, config.nodeEnv === "production");
        const minio = config.minioEndpoint && config.minioPort && config.minioAccessKey && config.minioSecretKey && config.minioBucket
            ? { client: new Client({ endPoint: config.minioEndpoint, port: config.minioPort, useSSL: config.nodeEnv === "production", accessKey: config.minioAccessKey, secretKey: config.minioSecretKey }), bucket: config.minioBucket }
            : { directory: new URL("../data/media", import.meta.url).pathname };
        // 回收无引用媒体：磁盘只增不减的根因靠这一步解决。启动时先跑一遍，之后每日一次。
        const sweepUnusedMedia = () => void clearUnusedMedia(database.pool, minio).catch((error: unknown) => logError("media-cleanup", error));
        sweepUnusedMedia();
        const mediaCleanupTimer = setInterval(sweepUnusedMedia, 24 * 60 * 60 * 1000);
        mediaCleanupTimer.unref();
        const apiRouter = createSessionRouter(database.pool, dependencies.secureCookie);
        apiRouter.use(createRegisterRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "register", secret) }));
        apiRouter.use(createLoginRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "login", secret) }));
        apiRouter.use(createCatalogRouter(catalog, database.pool, config.credentialsEncryptionKey));
        apiRouter.use(createCredentialRouter(database.pool, { encryptionKey: config.credentialsEncryptionKey }));
        apiRouter.use(createWorkspaceRouter(database.pool));
        apiRouter.use(createMediaRouter(database.pool, minio, config.rateLimitSecret));
        apiRouter.use(createGenerationRouter(database.pool, { catalog, encryptionKey: config.credentialsEncryptionKey, media: minio, appOrigin: config.appOrigin, mediaLinkSecret: config.rateLimitSecret }));
        const server = createApp({ appOrigin: config.appOrigin, apiRouter }).listen(config.port, config.host);
        let closing = false;
        const close = () => {
            if (closing) return;
            closing = true;
            clearInterval(mediaCleanupTimer);
            server.close(() => {
                void database.close().catch((error: unknown) => { logError("shutdown", error); process.exitCode = 1; });
            });
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
        server.on("error", (error) => {
            logError("listen", error);
            process.exitCode = 1;
            close();
        });
    } catch (error) {
        await database.close();
        throw error;
    }
}

void start().catch((error: unknown) => {
    logError("startup", error);
    process.exitCode = 1;
});
