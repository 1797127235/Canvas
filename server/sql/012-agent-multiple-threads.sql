-- Allow multiple assistant conversations per canvas project while preserving existing rows.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_agent_threads_pkey'
          AND conrelid = 'user_agent_threads'::regclass
          AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, project_id)'
    ) THEN
        ALTER TABLE user_agent_threads DROP CONSTRAINT user_agent_threads_pkey;
        ALTER TABLE user_agent_threads ADD PRIMARY KEY (user_id, project_id, thread_id);
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS user_agent_threads_thread_id_idx ON user_agent_threads(thread_id);
ALTER TABLE user_agent_threads ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '新对话';
