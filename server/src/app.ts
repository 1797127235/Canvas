import express, { type ErrorRequestHandler, type RequestHandler, type Router } from "express";
import helmet from "helmet";

const IDENTITY_BODY_LIMIT = "4kb";

type AppOptions = {
    appOrigin: string;
    apiRouter?: Router;
};

export function createApp(options: AppOptions) {
    const app = express();
    app.disable("x-powered-by");
    app.use(helmet());
    app.use(noStore);
    app.use(rejectUnsupportedEncoding);
    app.use(rejectCrossOriginStateChanges(options.appOrigin));
    app.use(express.json({ limit: IDENTITY_BODY_LIMIT, type: "application/json" }));
    app.use((request, response, next) => {
        if (request.path.startsWith("/api/") && ["POST", "PUT", "PATCH"].includes(request.method) && !request.is("application/json")) {
            return response.status(415).json({ error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "请求必须使用 JSON" } });
        }
        return next();
    });
    if (options.apiRouter) app.use("/api", options.apiRouter);
    app.use((_request, response) => {
        response.status(404).json({ error: { code: "NOT_FOUND", message: "接口不存在" } });
    });
    const handleError: ErrorRequestHandler = (error, _request, response, next) => {
        if (response.headersSent) return next(error);
        if (error instanceof SyntaxError && "body" in error) return response.status(400).json({ error: { code: "INVALID_REQUEST", message: "请求格式无效" } });
        if (isBodyParserError(error) && error.type === "entity.too.large") return response.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "请求内容过大" } });
        return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" } });
    };
    app.use(handleError);
    return app;
}

const noStore: RequestHandler = (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
};

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
