import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { clearExpiredIdentityData } from "./identity/cleanup.js";
import { createLoginRouter } from "./identity/login.js";
import { createRateLimiter } from "./identity/rate-limit.js";
import { createRegisterRouter } from "./identity/register.js";
import { createSessionRouter } from "./identity/session-routes.js";

async function start() {
    const config = readConfig(process.env);
    const database = createDatabase(config);
    try {
        // 启动时验证数据库/schema 并清理过期记录；认证拒绝过期凭证不依赖清理。
        await clearExpiredIdentityData(database.pool);
        const secret = config.rateLimitSecret;
        const dependencies = { database: database.pool, rateLimitSecret: secret, secureCookie: config.nodeEnv === "production" };
        const apiRouter = createSessionRouter(database.pool, dependencies.secureCookie);
        apiRouter.use(createRegisterRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "register", secret) }));
        apiRouter.use(createLoginRouter({ ...dependencies, limiter: createRateLimiter(database.pool, "login", secret) }));
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
