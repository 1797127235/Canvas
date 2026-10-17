import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response, type Router } from "express";
import helmet from "helmet";

import { logError, logRequest, loggedJson, REQ_BODY_LIMIT, RES_BODY_LIMIT } from "./log.js";

type AppOptions = {
    appOrigin: string;
    apiRouter?: Router;
};

export function createApp(options: AppOptions) {
    const app = express();
    app.disable("x-powered-by");
    app.use(helmet());
    app.use(noStore);
    app.use(logRequests());
    app.use(rejectUnsupportedEncoding);
    app.use(rejectCrossOriginStateChanges(options.appOrigin));
    // 媒体走原始上传流不设限；业务 JSON 按用途分档。
    // 素材改传身份后，生成请求体从 29.5MB 级降到 KB 级，1 MiB 仍有很宽余量；
    // 工作区要装下全部画布与助手会话，留 8 MiB；身份接口沿用原有 4 KiB。
    // 此前是 limit: Infinity，任何已登录账号都能用超大请求体把 api 进程内存打满。
    app.use(express.json({ limit: JSON_BODY_LIMIT, type: (request) => !request.url?.startsWith("/api/media") && Boolean(request.headers["content-type"]?.startsWith("application/json")), verify: rejectLargeBody }));
    app.use((request, response, next) => {
        if (request.path.startsWith("/api/") && !request.path.startsWith("/api/media") && ["POST", "PUT", "PATCH"].includes(request.method) && !request.is("application/json")) {
            return response.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "请求必须使用 JSON" } });
        }
        return next();
    });
    // 健康检查置于业务路由之前：credentials 等子路由在自身根上统一挂鉴权，会拦住未匹配路径。
    app.get("/api/health", (_request, response) => {
        response.json({ ok: true });
    });
    if (options.apiRouter) app.use("/api", options.apiRouter);
    app.use((_request, response) => {
        response.status(404).json({ error: { code: "NOT_FOUND", message: "接口不存在" } });
    });
    const handleError: ErrorRequestHandler = (error, request, response, next) => {
        if (response.headersSent) return next(error);
        if (error instanceof SyntaxError && "body" in error) return response.status(400).json({ error: { code: "INVALID_REQUEST", message: "请求格式无效" } });
        if (isBodyParserError(error) && error.type === "entity.too.large") return response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "请求内容过大" } });
        logError("http", error, { method: request.method, path: request.path });
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    };
    app.use(handleError);
    return app;
}

const IDENTITY_BODY_LIMIT = 4 * 1024;
const GENERATION_BODY_LIMIT = 1024 * 1024;
const JSON_BODY_LIMIT = 8 * 1024 * 1024;

const noStore: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
};

// 每个 /api 请求输出一行审计日志：方法、路径、状态码、耗时、账号，加上脱敏请求体与截断响应体；
// 媒体是二进制流，只记元信息；健康检查被容器高频轮询，不记。
function logRequests(): RequestHandler {
    return (request, response, next) => {
        if (!request.path.startsWith("/api/") || request.path === "/api/health") return next();
        const media = request.path.startsWith("/api/media");
        const start = Date.now();
        let resBody: unknown;
        if (!media) {
            const json = response.json.bind(response) as (body?: unknown) => Response;
            response.json = (body?: unknown) => {
                resBody = body;
                return json(body);
            };
        }
        response.on("finish", () => {
            // 中间件先于 body 解析挂载，请求体留到响应结束时读取。
            const reqBody = !media && request.body !== undefined ? loggedJson(request.body, REQ_BODY_LIMIT) : undefined;
            logRequest({
                method: request.method,
                path: request.originalUrl,
                status: response.statusCode,
                durationMs: Date.now() - start,
                userId: response.locals.user?.id as string | undefined,
                media: media || undefined,
                reqBody,
                resBody: media ? undefined : loggedJson(resBody, RES_BODY_LIMIT),
            });
        });
        return next();
    };
}

const rejectUnsupportedEncoding: RequestHandler = (request, response, next) => {
    if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") {
        return response.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "不支持压缩请求" } });
    }
    return next();
};

function rejectCrossOriginStateChanges(appOrigin: string): RequestHandler {
    return (request, response, next) => {
        if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method) || !request.path.startsWith("/api/")) return next();
        const source = request.headers.origin || request.headers.referer;
        if (!source || !isSameOrigin(source, appOrigin)) return response.status(403).json({ error: { code: "FORBIDDEN", message: "请求来源不受信任" } });
        return next();
    };
}

const rejectLargeBody = (request: Request, _response: Response, buffer: Buffer) => {
    const limit = bodyLimitFor(request.path);
    if (limit && buffer.length > limit) {
        const error = new Error("request body too large") as Error & { type: string; status: number };
        error.type = "entity.too.large";
        error.status = 413;
        throw error;
    }
};

function bodyLimitFor(path: string) {
    if (path.startsWith("/api/users") || path.startsWith("/api/sessions") || path.startsWith("/api/password-resets")) return IDENTITY_BODY_LIMIT;
    if (path.startsWith("/api/generations") || path.startsWith("/api/generation-tasks")) return GENERATION_BODY_LIMIT;
    return 0;
}

function isBodyParserError(error: unknown): error is Error & { type: string } {
    return error instanceof Error && "type" in error && typeof error.type === "string";
}

function isSameOrigin(source: string, appOrigin: string) {
    try {
        return new URL(source).origin === appOrigin;
    } catch {
        return false;
    }
}
