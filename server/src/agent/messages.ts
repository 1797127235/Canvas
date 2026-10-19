import type { ContentPart, Context, Message, Tool } from "@ag-ui/core";
import type { AssistantModelMessage, ImagePart, ModelMessage, ToolCallPart, ToolResultPart, ToolSet, UserContent } from "ai";
import { jsonSchema, tool } from "ai";

// AG-UI 的消息与工具定义直接来自浏览器，必须限额后再交给上游：
// 不设上限时一个账号可以把几百个工具塞进一次请求，既挤占上下文也放大上游计费。
// 不合格的工具静默丢弃——丢工具比整轮失败好。
const MAX_TOOLS = 32;
const MAX_DESCRIPTION = 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const FALLBACK_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;
const CLIENT_TOOL_OUTPUT_SCHEMA = { type: "object", additionalProperties: true } as const;

export function buildSystemPrompt(instructions: string, context: Context[]) {
    const blocks = context.filter((item) => item?.description && item.value).map((item) => `## ${item.description}\n${item.value}`);
    return [instructions, ...blocks].filter(Boolean).join("\n\n");
}

// 工具由浏览器执行：这里只把声明交给模型，故意不带 execute。
// AI SDK 在「调用了没有 execute 的工具」时结束本轮，由前端执行后把结果作为下一轮消息带回来。
export function toToolSet(tools: Tool[]): ToolSet | undefined {
    const usable = tools.filter((item) => item && typeof item.name === "string" && TOOL_NAME.test(item.name) && typeof item.description === "string" && item.description.trim());
    if (!usable.length) return undefined;
    return Object.fromEntries(
        usable.slice(0, MAX_TOOLS).map((item) => [
            item.name,
            tool({
                description: item.description.slice(0, MAX_DESCRIPTION),
                inputSchema: jsonSchema(jsonSchemaOrFallback(item.parameters)),
                outputSchema: jsonSchema(CLIENT_TOOL_OUTPUT_SCHEMA),
            }),
        ]),
    );
}


export function toModelMessages(messages: Message[]): ModelMessage[] {
    const result: ModelMessage[] = [];
    // tool 消息只带 toolCallId，工具名要从更早的 assistant 消息里反查。
    const toolNames = new Map<string, string>();
    for (const message of messages) {
        switch (message.role) {
            case "system":
            case "developer":
                // 客户端不能通过消息覆盖系统指令；instructions 只由服务端组装。
                break;
            case "user":
                result.push({ role: "user", content: userContent(message.content) });
                break;
            case "assistant": {
                const parts: Exclude<AssistantModelMessage["content"], string> = [];
                if (message.content) parts.push({ type: "text", text: message.content });
                for (const call of message.toolCalls ?? []) {
                    toolNames.set(call.id, call.function.name);
                    parts.push({ type: "tool-call", toolCallId: call.id, toolName: call.function.name, input: parseArguments(call.function.arguments) } satisfies ToolCallPart);
                }
                if (parts.length) result.push({ role: "assistant", content: parts });
                break;
            }
            case "tool": {
                result.push({
                    role: "tool",
                    content: [{ type: "tool-result", toolCallId: message.toolCallId, toolName: toolNames.get(message.toolCallId) ?? "unknown", output: { type: "text", value: textContent(message.content) } } satisfies ToolResultPart],
                });
                break;
            }
            // activity / reasoning 不是模型消息，丢弃。
            default:
                break;
        }
    }
    return result;
}

function jsonSchemaOrFallback(parameters: unknown) {
    if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
        const candidate = parameters as { type?: unknown; properties?: unknown };
        if (candidate.type === "object" && candidate.properties && typeof candidate.properties === "object") return parameters as Record<string, unknown>;
    }
    return FALLBACK_INPUT_SCHEMA;
}

function parseArguments(raw: string) {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return {};
    }
}

function textContent(content: string | Array<{ type: string; text?: string }>) {
    if (typeof content === "string") return content;
    return content
        .filter((part) => part?.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
}

function userContent(content: string | ContentPart[]): UserContent {
    if (typeof content === "string") return content;
    const parts: Exclude<UserContent, string> = [];
    for (const part of content) {
        if (part.type === "text") {
            if (part.text) parts.push({ type: "text", text: part.text });
            continue;
        }
        if (part.type !== "image") continue;
        const source = part.source;
        if (source.type === "data") parts.push({ type: "image", image: source.value, mediaType: source.mimeType } satisfies ImagePart);
        else if (source.type === "url") {
            try {
                parts.push({ type: "image", image: new URL(source.value), ...(source.mimeType ? { mediaType: source.mimeType } : {}) } satisfies ImagePart);
            } catch {
                // 非法 URL 直接忽略，不让一条坏消息把整轮对话打死。
            }
        }
    }
    return parts.length ? parts : "";
}
