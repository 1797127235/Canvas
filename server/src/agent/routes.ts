import { Router, type Request, type Response } from "express";
import type { Pool } from "pg";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { RateLimiterPostgres } from "rate-limiter-flexible";
import { z } from "zod";

import type { Catalog } from "../catalog/catalog.js";
import { accountModels } from "../catalog/catalog.js";
import { readUserCredential } from "../credentials.js";
import { requireUser } from "../identity/auth-middleware.js";
import { consumeUserRateLimit } from "../identity/rate-limit.js";
import { logError } from "../log.js";
import { readAccountMediaImageBytes, type MediaOptions } from "../media.js";
import { streamAgentRun } from "./run.js";
import type { CompactionBudget } from "./compaction/context.js";
import { AgentThreadError, createSessionStore, validateMessages } from "./sessions/store.js";

const AGENT_ID = "default";
const AGENT_INFO = { name: "画布助手", description: "理解当前画布并协助搭建生成流程" };
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
// 附件交给模型的图片走画布预览的 2048 档。手机原图动辄几千万像素，直读原图既占内存又白烧 token，
// 而上游本就会把长边压到 ~1568，2048 档不丢它要用的细节。要更高保真就改这一处。
const AGENT_IMAGE_TIER = 2048;

const saveSchema = z.strictObject({ messages: z.array(z.unknown()) });

export type AgentOptions = {
    database: Pool;
    catalog: Catalog;
    encryptionKey?: string;
    limiter?: RateLimiterPostgres;
    rateLimitSecret?: string;
    compactionBudgets?: Record<string, CompactionBudget>;
    media?: MediaOptions;
};

export function createAgentRouter(options: AgentOptions) {
    const router = Router();
    const threads = createSessionStore(options.database);
    // 断流后摘要 SQL 可能仍在收尾；版本读取必须等它结算，不能读到提交前的旧版本。
    const activeRuns = new Map<string, Promise<void>>();
    const settled = async (threadId: string) => { await activeRuns.get(threadId)?.then(() => undefined, () => undefined); };
    router.use(requireUser(options.database));

    // 前端 CopilotKitCore 启动时读它来发现 agent，未登录时前端据此提示登录。
    router.get("/copilotkit/info", (_request, response) => {
        response.json({ version: "0.1.0", mode: "sse", agents: { [AGENT_ID]: AGENT_INFO }, compaction: { configuredModels: Object.keys(options.compactionBudgets ?? {}) } });
    });

    router.post("/copilotkit/agent/:agentId/run", async (request, response) => {
        if (request.params.agentId !== AGENT_ID) return response.status(404).json({ error: { code: "AGENT_NOT_FOUND", message: "助手不存在" } });
        const userId = response.locals.user.id as string;
        const parsed = RunAgentInputSchema.safeParse(request.body);
        if (!parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "对话请求格式无效" } });
        const input = parsed.data;
        // 客户端在 properties 里声明自己在哪个画布项目；没有它就无法校验会话归属，直接拒绝。
        const projectId = typeof input.forwardedProps?.projectId === "string" ? input.forwardedProps.projectId : "";
        if (!PROJECT_ID.test(projectId)) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "缺少画布标识" } });
        if (!(await threads.owns(userId, projectId, input.threadId))) return response.status(409).json({ error: { code: "AGENT_THREAD_MISMATCH", message: "对话不属于当前画布，请重新打开助手" } });
        if (activeRuns.has(input.threadId)) return response.status(409).json({ error: { code: "AGENT_THREAD_BUSY", message: "会话正在运行，请稍后重试" } });
        let releaseRun!: () => void;
        const reservation = new Promise<void>((resolve) => { releaseRun = resolve; });
        activeRuns.set(input.threadId, reservation);

        try {
            try {
                if (options.limiter && options.rateLimitSecret) await consumeUserRateLimit(options.limiter, options.rateLimitSecret, "agent", userId);
            } catch {
                return response.status(429).json({ error: { code: "RATE_LIMITED", message: "对话太频繁，请稍后再试" } });
            }

            const credential = await readUserCredential(options.database, userId, options.encryptionKey);
            if (!credential) return response.status(409).json({ error: { code: "API_KEY_REQUIRED", message: "请先在配置页保存账号 API Key" } });
            let candidates: Awaited<ReturnType<typeof accountModels>>;
            try {
                candidates = await accountModels(options.catalog, credential.apiKey, credential.baseUrl);
            } catch {
                return response.status(502).json({ error: { code: "UPSTREAM_ERROR", message: "上游模型获取失败，请检查账号 API Key 和上游服务" } });
            }
            const textModels = candidates.filter((model) => model.capability === "text");
            const requestedModelId = typeof input.forwardedProps?.modelId === "string" ? input.forwardedProps.modelId : undefined;
            const model = requestedModelId ? textModels.find((candidate) => candidate.id === requestedModelId) : textModels[0];
            if (!model) return response.status(424).json({ error: { code: "AGENT_MODEL_UNAVAILABLE", message: "当前账号没有可用的文本模型，助手暂时不可用" } });

            const controller = new AbortController();
            response.once("close", () => controller.abort());
            // 附件按身份读取，归属校验在 readAccountMediaImageBytes 里做，避免客户端伪造别人的 remote id。
            const readMedia = async (mediaId: string) => {
                if (!options.media) throw new Error("媒体存储尚未配置");
                return readAccountMediaImageBytes(options.database, options.media, userId, mediaId, AGENT_IMAGE_TIER);
            };
            try {
                await streamAgentRun({ model, apiKey: credential.apiKey, input, signal: controller.signal, response, sessions: threads, userId, projectId, budget: options.compactionBudgets?.[model.upstreamModel], readMedia });
            } catch (error) {
                logError("agent", error, { userId });
                if (!response.headersSent) return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "助手响应失败，请重试" } });
            }
        } finally {
            activeRuns.delete(input.threadId);
            releaseRun();
        }
    });

    router.get("/agent/threads/:projectId", async (request, response) => {
        const projectId = readProjectId(request, response);
        if (!projectId) return;
        try {
            const userId = response.locals.user.id as string;
            const listed = await threads.list(userId, projectId);
            return response.json(listed.length ? listed : [await threads.ensure(userId, projectId)]);
        } catch (error) {
            return threadFailure(response, error);
        }
    });

    router.post("/agent/threads/:projectId", async (request, response) => {
        const projectId = readProjectId(request, response);
        if (!projectId) return;
        try {
            return response.status(201).json(await threads.create(response.locals.user.id as string, projectId));
        } catch (error) {
            return threadFailure(response, error);
        }
    });

    router.get("/agent/threads/:projectId/:threadId", async (request, response) => {
        const projectId = readProjectId(request, response);
        if (!projectId) return;
        try {
            await settled(String(request.params.threadId));
            return response.json(await threads.get(response.locals.user.id as string, projectId, String(request.params.threadId)));
        } catch (error) {
            return threadFailure(response, error);
        }
    });

    router.put("/agent/threads/:projectId/:threadId", async (request, response) => {
        const projectId = readProjectId(request, response);
        if (!projectId) return;
        const version = Number(request.header("if-match-version"));
        const parsed = saveSchema.safeParse(request.body);
        if (!request.header("if-match-version") || !Number.isSafeInteger(version) || version < 0 || !parsed.success) return response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "会话数据或版本无效" } });
        try {
            await settled(String(request.params.threadId));
            const messages = validateMessages(parsed.data.messages);
            return response.json(await threads.save(response.locals.user.id as string, projectId, String(request.params.threadId), version, messages));
        } catch (error) {
            return threadFailure(response, error);
        }
    });

    router.delete("/agent/threads/:projectId/:threadId", async (request, response) => {
        const projectId = readProjectId(request, response);
        if (!projectId) return;
        try {
            await settled(String(request.params.threadId));
            await threads.delete(response.locals.user.id as string, projectId, String(request.params.threadId));
            return response.status(204).end();
        } catch (error) {
            return threadFailure(response, error);
        }
    });

    return router;
}

function readProjectId(request: Request, response: Response) {
    const projectId = String(request.params.projectId ?? "");
    if (!PROJECT_ID.test(projectId)) {
        response.status(422).json({ error: { code: "VALIDATION_ERROR", message: "画布标识无效" } });
        return null;
    }
    return projectId;
}

function threadFailure(response: Response, error: unknown) {
    if (error instanceof AgentThreadError) {
        const status = error.failure === "not-found" ? 404 : error.failure === "conflict" ? 409 : error.failure === "invalid" ? 422 : 413;
        const code = error.failure === "not-found" ? "AGENT_THREAD_NOT_FOUND" : error.failure === "conflict" ? "AGENT_THREAD_CONFLICT" : error.failure === "invalid" ? "VALIDATION_ERROR" : "AGENT_THREAD_TOO_LARGE";
        return response.status(status).json({ error: { code, message: error.message } });
    }
    logError("agent-threads", error);
    return response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "会话读写失败" } });
}
