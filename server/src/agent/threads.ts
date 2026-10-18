import { randomUUID } from "node:crypto";

import type { Message } from "@ag-ui/core";
import type { Pool } from "pg";

// 单会话上限：超限就让用户开新对话，不静默裁剪历史。
// 裁掉几条之后模型会基于残缺上下文回答，比明确报错更糟。
export const MAX_THREAD_BYTES = 2 * 1024 * 1024;
export const MAX_THREAD_MESSAGES = 400;

export type AgentThread = { threadId: string; version: number; messages: Message[] };
export type ThreadFailure = "not-found" | "conflict" | "too-large";

export class AgentThreadError extends Error {
    constructor(readonly failure: ThreadFailure, message: string) {
        super(message);
    }
}

export function validateMessages(value: unknown): Message[] {
    if (!Array.isArray(value)) throw new AgentThreadError("too-large", "会话消息格式无效");
    if (value.length > MAX_THREAD_MESSAGES) throw new AgentThreadError("too-large", `对话超过 ${MAX_THREAD_MESSAGES} 条，请开新对话`);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_THREAD_BYTES) throw new AgentThreadError("too-large", "对话内容过大，请开新对话");
    return value as Message[];
}

// 会话仓储：一个账号的一个画布项目一条会话，threadId 由服务端签发。
// 客户端提交的 threadId 一律按 (user, project) 反查归属，避免伪造别人的会话。
export function createThreadStore(database: Pool) {
    return {
        // 取会话，没有就建一条。用 upsert 保证并发打开同一项目时不会插入两行。
        async ensure(userId: string, projectId: string): Promise<AgentThread> {
            const result = await database.query<{ thread_id: string; version: string; messages: Message[] }>(
                `INSERT INTO user_agent_threads (user_id, project_id, thread_id)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, project_id) DO UPDATE SET updated_at = user_agent_threads.updated_at
                 RETURNING thread_id, version, messages`,
                [userId, projectId, randomUUID()],
            );
            return toThread(result.rows[0]);
        },

        async save(userId: string, projectId: string, version: number, messages: Message[]): Promise<{ version: number }> {
            const result = await database.query<{ version: string }>(
                `UPDATE user_agent_threads
                 SET version = version + 1, messages = $4::jsonb, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND project_id = $2 AND version = $3::bigint
                 RETURNING version`,
                [userId, projectId, version, JSON.stringify(messages)],
            );
            if (result.rows[0]) return { version: Number(result.rows[0].version) };
            const exists = await database.query("SELECT 1 FROM user_agent_threads WHERE user_id = $1 AND project_id = $2", [userId, projectId]);
            if (!exists.rows[0]) throw new AgentThreadError("not-found", "会话不存在");
            throw new AgentThreadError("conflict", "对话已在其他页面更新，请重新打开");
        },

        // 「新对话」：清空消息并换一个 threadId，旧 threadId 立即失效。
        async reset(userId: string, projectId: string): Promise<{ threadId: string; version: number }> {
            const result = await database.query<{ thread_id: string; version: string }>(
                `UPDATE user_agent_threads
                 SET thread_id = $3, version = version + 1, messages = '[]'::jsonb, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND project_id = $2
                 RETURNING thread_id, version`,
                [userId, projectId, randomUUID()],
            );
            const row = result.rows[0];
            if (!row) throw new AgentThreadError("not-found", "会话不存在");
            return { threadId: row.thread_id, version: Number(row.version) };
        },

        // run 之前的归属校验：客户端说自己在某个项目里，就必须真的持有那个会话。
        async owns(userId: string, projectId: string, threadId: string): Promise<boolean> {
            const result = await database.query("SELECT 1 FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 AND thread_id = $3", [userId, projectId, threadId]);
            return Boolean(result.rows[0]);
        },

        // 画布项目删掉后，对应会话没有外键可依赖（项目 id 在工作区 JSON 里），
        // 所以在工作区保存时按当前项目列表回收。
        async pruneOrphans(userId: string, projectIds: string[]): Promise<void> {
            await database.query("DELETE FROM user_agent_threads WHERE user_id = $1 AND NOT (project_id = ANY($2::text[]))", [userId, projectIds]);
        },
    };
}

export type ThreadStore = ReturnType<typeof createThreadStore>;

function toThread(row: { thread_id: string; version: string; messages: Message[] }): AgentThread {
    return { threadId: row.thread_id, version: Number(row.version), messages: Array.isArray(row.messages) ? row.messages : [] };
}
