import pino from "pino";

type LogContext = { method?: string; path?: string } & Record<string, unknown>;

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

// 截断并脱敏一段文本（上游响应体、错误详情等），防止密钥和超大内容进入日志。
export function redactText(value: string, limit = 2048) {
    const text = value.length > limit ? `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]` : value;
    return redact(text);
}

export function logRequest(fields: { method: string; path: string; status: number; durationMs: number; userId?: string; media?: boolean; reqBody?: unknown; resBody?: unknown }) {
    logger.info({ scope: "http", ...fields }, "request");
}

// 请求日志的体量上限：请求体超过按 16KiB 截断，响应体按 4KiB 截断，只影响日志不影响接口行为。
export const REQ_BODY_LIMIT = 16384;
export const RES_BODY_LIMIT = 4096;

const SECRET_FIELDS = /^(password|currentpassword|newpassword)$/i;
const KEY_FIELDS = /^(apikey|api_key)$/i;
// 内联素材：请求里的参考图/视频/音频是 data URL，生图结果里的 b64_json 是裸 base64。
const DATA_URL = /^data:[\w.+-]+\/[\w.+-]+;base64,/;
const BASE64_FIELDS = /^b64_json$/i;

// 日志里只出现可 JSON 序列化的值；脱敏不改变形状，只把字符串里的内联素材换成摘要。
type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

export function sanitizeBody(value: unknown): LogValue {
    if (typeof value === "string") return summarizeDataUrl(value);
    if (Array.isArray(value)) return value.map(sanitizeBody);
    if (value === null || value === undefined) return value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    // 请求体来自 JSON.parse，正常不会出现函数/symbol；真出现时落成文本比直接丢掉更好排查。
    if (typeof value !== "object") return String(value);
    return Object.fromEntries(Object.entries(value as Record<string, LogValue>).map(([key, item]) => [key, sanitizeField(key, item)]));
}

function sanitizeField(key: string, item: unknown): LogValue {
    if (SECRET_FIELDS.test(key) && typeof item === "string" && item) return "[redacted]";
    if (KEY_FIELDS.test(key) && typeof item === "string" && item) return `${item.slice(0, 6)}…(len ${item.length})`;
    if (BASE64_FIELDS.test(key) && typeof item === "string" && item) return `<base64 省略 ${base64Bytes(item)} 字节>`;
    return sanitizeBody(item);
}

// 内联素材只记类型和体积：日志既不需要二进制内容，也不该保存用户素材，而且原始字节会吃掉截断配额、把真正有用的参数挤出去。
function summarizeDataUrl(value: string) {
    const match = DATA_URL.exec(value);
    if (!match) return value;
    return `${match[0]}<省略 ${base64Bytes(value.slice(match[0].length))} 字节>`;
}

function base64Bytes(payload: string) {
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    return Math.floor((payload.length * 3) / 4) - padding;
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
