ALTER TABLE user_agent_threads ADD COLUMN IF NOT EXISTS compaction_summary TEXT;
ALTER TABLE user_agent_threads ADD COLUMN IF NOT EXISTS covered_through_message_id TEXT;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_agent_threads_compaction_state_check'
          AND conrelid = 'user_agent_threads'::regclass
    ) THEN
        ALTER TABLE user_agent_threads
            ADD CONSTRAINT user_agent_threads_compaction_state_check
            CHECK ((compaction_summary IS NULL) = (covered_through_message_id IS NULL));
    END IF;
END $$;
