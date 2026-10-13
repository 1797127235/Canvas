-- 图片生成的异步任务：画布刷新后可按任务号恢复，结果落到账号媒体。
ALTER TABLE user_generation_tasks ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'video';
ALTER TABLE user_generation_tasks ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE user_generation_tasks ADD COLUMN IF NOT EXISTS result JSONB;
ALTER TABLE user_generation_tasks ADD COLUMN IF NOT EXISTS error TEXT;
