import { APICallError } from "ai";


export const gatewayFetch: typeof fetch = (input, init) => {
    try {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
        return fetch(url, { ...init, redirect: "error" });
    } catch {
        throw new Error("上游网关地址无效");
    }
};

type GatewayResponse = { value: unknown; headers: Headers };

export async function gatewayJson(url: string, apiKey: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string | undefined>): Promise<GatewayResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    for (const [key, value] of Object.entries(extra || {})) if (value !== undefined) headers[key] = value;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await gatewayFetch(url, {
        method: body === undefined ? "GET" : "POST", signal, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
        let message = "上游生成失败，请检查模型和参数";
        try {
            const payload = JSON.parse(text);
            message = payload.error?.message || payload.message || message;
        } catch {
            // 上游不可用时网关（Cloudflare 等）返回的是 HTML 错误页，只保留状态码，不回显 HTML 正文。
            message = response.status >= 500 ? "上游服务暂时不可用，请稍后重试" : `上游返回了无法解析的错误（HTTP ${response.status}）`;
        }
        throw new APICallError({ message, url, requestBodyValues: undefined, statusCode: response.status, responseBody: text, isRetryable: false });
    }
    try { return { value: JSON.parse(text) as unknown, headers: response.headers }; }
    catch {
        // 上游返回非 JSON（网关 HTML 页、空响应等）：状态码与正文交给上游日志，用户侧只看到一句可读结论。
        throw new APICallError({ message: "上游返回了非 JSON 响应，请检查模型协议端点", url, requestBodyValues: undefined, statusCode: response.status, responseBody: text, isRetryable: false });
    }
}

