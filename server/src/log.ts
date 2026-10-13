import pino from "pino";

type LogContext = { method?: string; path?: string };

// 日志统一走 pino 输出 JSON 行到 stdout，由容器 json-file 轮转收集；级别可用 LOG_LEVEL 覆盖。
let logger = pino({ level: process.env.LOG_LEVEL || "info" });

// 测试捕获用：把日志重定向到内存流，常规运行不需要调用。
export function initLogging(destination: NodeJS.WritableStream) {
    logger = pino({ level: "info" }, destination);
}

export function logError(scope: string, error: unknown, context: LogContext = {}) {
    const detail = error instanceof Error ? { name: error.name, message: redact(error.message) } : { name: "UnknownError", message: "未知错误" };
    logger.error({ scope, ...context, ...detail }, scope);
}

export function logRequest(fields: { method: string; path: string; status: number; durationMs: number; userId?: string; media?: boolean; reqBody?: unknown; resBody?: unknown }) {
    logger.info({ scope: "http", ...fields }, "request");
}

// 请求日志的体量上限：请求体超过按 16KiB 截断，响应体按 4KiB 截断，只影响日志不影响接口行为。
export const REQ_BODY_LIMIT = 16384;
export const RES_BODY_LIMIT = 4096;

const SECRET_FIELDS = /^(password|currentpassword|newpassword)$/i;
const KEY_FIELDS = /^(apikey|api_key)$/i;

export function sanitizeBody(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sanitizeBody);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeField(key, item)]));
}

function sanitizeField(key: string, item: unknown): unknown {
    if (SECRET_FIELDS.test(key) && typeof item === "string" && item) return "[redacted]";
    if (KEY_FIELDS.test(key) && typeof item === "string" && item) return `${item.slice(0, 6)}…(len ${item.length})`;
    return sanitizeBody(item);
}

export function truncateJson(value: unknown, limit: number) {
    if (value === undefined) return undefined;
    const text = JSON.stringify(value) ?? "";
    if (text.length <= limit) return value;
    return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

// 记进日志的标准入口：先脱敏再截断。
export function loggedJson(value: unknown, limit: number) {
    return truncateJson(sanitizeBody(value), limit);
}

function redact(value: string) {
    return value
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@");
}
