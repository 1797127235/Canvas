CREATE TABLE IF NOT EXISTS user_generation_tasks (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation JSONB NOT NULL,
    base_url TEXT NOT NULL,
    model_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'video',
    status TEXT,
    result JSONB,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS user_generation_tasks_user_created_idx ON user_generation_tasks(user_id, created_at DESC);
