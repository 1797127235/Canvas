CREATE TABLE IF NOT EXISTS user_generation_history (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    id TEXT NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (user_id, kind, id)
);
