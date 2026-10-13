BEGIN;

ALTER TABLE user_generation_tasks ADD COLUMN IF NOT EXISTS operation JSONB;

-- 一次性保留旧任务 UUID、账号归属、上游地址和任务号；运行时只使用 SDK operation。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'user_generation_tasks' AND column_name = 'upstream_id') THEN
        UPDATE user_generation_tasks
        SET operation = jsonb_build_object(
            'version', 1, 'adapter', 'gateway-videos', 'modelId', model_id,
            'operation', jsonb_build_object('id', upstream_id)
        )
        WHERE operation IS NULL;
        ALTER TABLE user_generation_tasks DROP COLUMN upstream_id;
    END IF;
END $$;

ALTER TABLE user_generation_tasks ALTER COLUMN operation SET NOT NULL;

COMMIT;
