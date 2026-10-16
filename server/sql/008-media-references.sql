-- 账号媒体的引用索引：保存工作区时从整份文档里收集 remote:<uuid> 并整体重建，
-- 回收任务据此找出「创建超过宽限期且不再被任何画布/助手会话/资产引用」的媒体。
-- 只存引用关系，不存字节；重建是幂等的，不依赖增量更新。
CREATE TABLE IF NOT EXISTS user_media_references (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, media_id)
);

-- 回收按 media_id 反查引用，主键顺序是 (user_id, media_id)，这里再建一条反向索引。
CREATE INDEX IF NOT EXISTS user_media_references_media_idx ON user_media_references(media_id);
