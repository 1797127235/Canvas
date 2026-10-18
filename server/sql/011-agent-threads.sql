-- 画布 Agent 的会话存储：一个账号的一个画布项目一条会话。
-- 不复用 user_workspaces.data：工作区是整份文档替换 + 乐观锁，对话每来一条消息就 bump 一次
-- 版本号，会让对话和画布编辑互相 409；会话在这里独立演进。
-- messages 原样存 AG-UI 的 Message[]，刷新后直接回填客户端，不需要自建消息结构。
CREATE TABLE IF NOT EXISTS user_agent_threads (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    thread_id UUID NOT NULL,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, project_id)
);

-- 客户端带上来的 threadId 要按 (user, project) 反查归属，避免伪造别人的会话。
CREATE INDEX IF NOT EXISTS user_agent_threads_thread_idx ON user_agent_threads(thread_id);
