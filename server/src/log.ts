type LogContext = { method?: string; path?: string };

export function logError(scope: string, error: unknown, context: LogContext = {}) {
    const detail = error instanceof Error ? { name: error.name, message: redact(error.message) } : { name: "UnknownError", message: "未知错误" };
    console.error(JSON.stringify({ level: "error", time: new Date().toISOString(), scope, ...context, ...detail }));
}

function redact(value: string) {
    return value
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
        .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, "postgresql://[redacted]@");
}
