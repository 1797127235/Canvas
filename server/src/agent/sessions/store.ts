import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MessageSchema } from "@ag-ui/core/schemas";

import { safeBoundaries } from "./message-boundaries.js";

import type { Message } from "@ag-ui/core";
import type { Pool } from "pg";

export const MAX_THREAD_BYTES = 2 * 1024 * 1024;
export const MAX_THREAD_MESSAGES = 400;
export type AgentThread = { threadId: string; title: string; version: number; messages: Message[]; updatedAt: string };
export type AgentSession = AgentThread & { compactionSummary: string | null; coveredThroughMessageId: string | null };
export type ThreadFailure = "not-found" | "conflict" | "too-large" | "invalid";

export class AgentThreadError extends Error {
    constructor(readonly failure: ThreadFailure, message: string) {
        super(message);
    }
}

export function validateMessages(value: unknown): Message[] {
    if (!Array.isArray(value)) throw new AgentThreadError("too-large", "会话消息格式无效");
    if (value.length > MAX_THREAD_MESSAGES) throw new AgentThreadError("too-large", `对话超过 ${MAX_THREAD_MESSAGES} 条，请开新对话`);
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_THREAD_BYTES) throw new AgentThreadError("too-large", "对话内容过大，请开新对话");
    const ids = new Set<string>();
    for (const message of value) {
        const parsed = MessageSchema.safeParse(message);
        if (!parsed.success || !parsed.data.id || ids.has(parsed.data.id)) throw new AgentThreadError("invalid", "消息格式或 ID 无效");
        ids.add(parsed.data.id);
    }
    return value as Message[];
}

export function titleFromMessages(messages: Message[]) {
    const first = messages.find((message) => message.role === "user");
    const content = first?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text).join(" ") : "";
    return text.replace(/\s+/g, " ").trim().slice(0, 48) || "新对话";
}

export function createSessionStore(database: Pool) {
    return {
        async list(userId: string, projectId: string): Promise<AgentThread[]> {
            const result = await database.query<SessionRow>("SELECT thread_id, title, version, messages, updated_at FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 ORDER BY updated_at DESC", [userId, projectId]);
            return result.rows.map(toThread);
        },
        async ensure(userId: string, projectId: string): Promise<AgentThread> {
            const result = await database.query<SessionRow>(
                `INSERT INTO user_agent_threads (user_id, project_id, thread_id)
                 SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM user_agent_threads WHERE user_id = $1 AND project_id = $2)
                 ON CONFLICT DO NOTHING
                 RETURNING thread_id, title, version, messages, updated_at`,
                [userId, projectId, randomUUID()],
            );
            if (result.rows[0]) return toThread(result.rows[0]);
            const sessions = await this.list(userId, projectId);
            return sessions[0];
        },
        async create(userId: string, projectId: string): Promise<AgentThread> {
            const result = await database.query<SessionRow>("INSERT INTO user_agent_threads (user_id, project_id, thread_id) VALUES ($1, $2, $3) RETURNING thread_id, title, version, messages, updated_at", [userId, projectId, randomUUID()]);
            return toThread(result.rows[0]);
        },
        async get(userId: string, projectId: string, threadId: string): Promise<AgentThread> {
            const session = await this.getForCompaction(userId, projectId, threadId);
            return toThread({ thread_id: session.threadId, title: session.title, version: String(session.version), messages: session.messages, updated_at: session.updatedAt });
        },
        async getForCompaction(userId: string, projectId: string, threadId: string): Promise<AgentSession> {
            const result = await database.query<SessionRow>("SELECT thread_id, title, version, messages, updated_at, compaction_summary, covered_through_message_id FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 AND thread_id = $3", [userId, projectId, threadId]);
            if (!result.rows[0]) throw new AgentThreadError("not-found", "会话不存在");
            return toSession(result.rows[0]);
        },
        async save(userId: string, projectId: string, threadId: string, version: number, messages: Message[]): Promise<{ version: number; title: string }> {
            validateMessages(messages);
            const session = await this.getForCompaction(userId, projectId, threadId);
            if (session.version !== version) throw new AgentThreadError("conflict", "对话已在其他页面更新，请重新打开");
            if (session.coveredThroughMessageId !== null) {
                const end = session.messages.findIndex((message) => message.id === session.coveredThroughMessageId) + 1;
                if (!end || !isDeepStrictEqual(session.messages.slice(0, end), messages.slice(0, end))) throw new AgentThreadError("conflict", "已压缩的历史不能删除或改写");
            }
            const result = await database.query<{ version: string; title: string }>(
                `UPDATE user_agent_threads SET version = version + 1, messages = $5::jsonb,
                 title = CASE WHEN title = '新对话' AND $5::jsonb <> '[]'::jsonb THEN $6 ELSE title END,
                 updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND project_id = $2 AND thread_id = $3 AND version = $4::bigint RETURNING version, title`,
                [userId, projectId, threadId, version, JSON.stringify(messages), titleFromMessages(messages)],
            );
            if (result.rows[0]) return { version: Number(result.rows[0].version), title: result.rows[0].title };
            return this.throwMissingOrConflict(userId, projectId, threadId);
        },
        async updateCompactionState(userId: string, projectId: string, threadId: string, version: number, summary: string, coveredThroughMessageId: string): Promise<number> {
            const session = await this.getForCompaction(userId, projectId, threadId);
            if (session.version !== version) throw new AgentThreadError("conflict", "对话已在其他页面更新，请重新打开");
            const end = session.messages.findIndex((message) => message.id === coveredThroughMessageId) + 1;
            const previous = session.coveredThroughMessageId === null ? 0 : session.messages.findIndex((message) => message.id === session.coveredThroughMessageId) + 1;
            if (!summary.trim() || !end || end <= previous || !safeBoundaries(session.messages).has(end)) throw new AgentThreadError("invalid", "压缩摘要或边界无效");
            const result = await database.query<{ version: string }>(
                `UPDATE user_agent_threads SET compaction_summary = $5, covered_through_message_id = $6,
                 version = version + 1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $1 AND project_id = $2 AND thread_id = $3 AND version = $4::bigint RETURNING version`,
                [userId, projectId, threadId, version, summary, coveredThroughMessageId],
            );
            if (result.rows[0]) return Number(result.rows[0].version);
            return this.throwMissingOrConflict(userId, projectId, threadId);
        },
        async delete(userId: string, projectId: string, threadId: string): Promise<void> {
            const result = await database.query("DELETE FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 AND thread_id = $3", [userId, projectId, threadId]);
            if (!result.rowCount) throw new AgentThreadError("not-found", "会话不存在");
        },
        async owns(userId: string, projectId: string, threadId: string): Promise<boolean> {
            const result = await database.query("SELECT 1 FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 AND thread_id = $3", [userId, projectId, threadId]);
            return Boolean(result.rows[0]);
        },
        async pruneOrphans(userId: string, projectIds: string[]): Promise<void> {
            await database.query("DELETE FROM user_agent_threads WHERE user_id = $1 AND NOT (project_id = ANY($2::text[]))", [userId, projectIds]);
        },
        async throwMissingOrConflict(userId: string, projectId: string, threadId: string): Promise<never> {
            const exists = await database.query("SELECT 1 FROM user_agent_threads WHERE user_id = $1 AND project_id = $2 AND thread_id = $3", [userId, projectId, threadId]);
            if (!exists.rows[0]) throw new AgentThreadError("not-found", "会话不存在");
            throw new AgentThreadError("conflict", "对话已在其他页面更新，请重新打开");
        },
    };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
type SessionRow = { thread_id: string; title: string; version: string; messages: Message[]; updated_at: Date | string; compaction_summary?: string | null; covered_through_message_id?: string | null };
function toThread(row: SessionRow): AgentThread {
    const session = toSession(row);
    return { threadId: session.threadId, title: session.title, version: session.version, messages: session.messages, updatedAt: session.updatedAt };
}
function toSession(row: SessionRow): AgentSession {
    const messages = Array.isArray(row.messages) ? row.messages : [];
    return { threadId: row.thread_id, title: row.title === "新对话" ? titleFromMessages(messages) : row.title, version: Number(row.version), messages, updatedAt: new Date(row.updated_at).toISOString(), compactionSummary: row.compaction_summary ?? null, coveredThroughMessageId: row.covered_through_message_id ?? null };
}
