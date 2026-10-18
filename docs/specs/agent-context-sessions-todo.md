# Tasks: Agent Context Sessions

状态：**sessions 基础及 PostgreSQL 集成验收已完成**；前端登录浏览器完整生命周期待验收。对应规格：[agent-context-sessions.md](./agent-context-sessions.md)；技术计划：[agent-context-sessions-plan.md](./agent-context-sessions-plan.md)。本阶段未实现 compaction 摘要生成或模型上下文裁剪。

## Task 1: 为会话添加压缩状态字段

**Description:** 新增顺序 SQL 迁移，给 `user_agent_threads` 加入当前摘要和覆盖边界消息 ID；注册迁移并确认新旧表结构对齐。

**Acceptance criteria:**
- [x] 每个会话可存储空或非空摘要及可空的 `covered_through_message_id`。
- [x] 迁移可在当前数据库 schema 上安全重复执行，且不删除或重写已有消息；隔离 PostgreSQL 实跑待执行。
- [x] 启动迁移注册顺序正确；通信协议版本不因本地消息存储变化而改变。

**Verification:**
- [x] SQL migration test 覆盖已有消息保留、已有会话及重复执行（隔离 PostgreSQL）。
- [x] `cd server && bun run typecheck` 通过。

**Dependencies:** None

**Files likely touched:**
- `server/sql/<next>-agent-thread-compaction.sql`
- `server/src/index.ts`
- `server/tests/<migration-test>.test.ts` 或现有迁移测试文件

**Estimated scope:** Medium

## Task 2: 建立 sessions store 与受版本保护的写入

**Description:** 将现有 `threads.ts` 持久化职责迁至 `server/src/agent/sessions/`，提供会话 CRUD、消息保存和服务端摘要状态更新；所有操作继续按 user/project/thread 校验，消息与摘要写入共用版本号。

**Acceptance criteria:**
- [x] Store 内部可读取完整 messages 与 compaction state，原始消息不被摘要替换或删除。
- [x] 消息保存接口只写 messages/title，不触碰摘要及边界字段。
- [x] 摘要更新仅由服务端调用，校验边界 message ID 属于同一会话并存在于完整历史。
- [x] 消息保存和摘要写入都要求 expected version，成功递增同一 version；冲突明确失败且无部分覆盖。
- [x] 路由及工作区孤儿清理改用新 store；旧 `threads.ts` 已移除。

**Verification:**
- [x] 单测覆盖压缩边界、历史保留、公开投影和并发版本冲突；CRUD/权限集成待 PostgreSQL 执行。
- [x] `cd server && bun run typecheck` 通过。

**Dependencies:** Task 1

**Files likely touched:**
- `server/src/agent/sessions/store.ts`
- `server/src/agent/sessions/types.ts`（仅在确有需要时）
- `server/src/agent/threads.ts`（移除原实现）
- `server/src/agent/routes.ts`
- `server/tests/agent-threads.test.ts` 或对应新测试

**Estimated scope:** Medium

## Task 3: 固定客户端消息接口不写摘要

**Description:** 检查并收紧 HTTP 路由输入 schema，保证客户端会话保存请求只能包含消息；摘要及边界不得被忽略式接受或写入。保持现有列表、创建、读取、删除响应契约。

**Acceptance criteria:**
- [x] 客户端保存 schema 使用严格对象，仅接受 messages，摘要/边界字段会被拒绝。
- [ ] 正常消息保存仍使用现有 `If-Match-Version` 乐观锁和标题生成行为。
- [ ] 会话仍按账号、项目和 thread 隔离。

**Verification:**
- [x] 路由保存 schema 为严格对象，仅接受 messages；摘要字段不能由客户端写入。
- [x] `cd server && bun run test` 在隔离 PostgreSQL 上 138/138 通过。

**Dependencies:** Task 2

**Files likely touched:**
- `server/src/agent/routes.ts`
- `server/tests/agent-threads.test.ts` 或对应路由测试

**Estimated scope:** Small

## Task 4: 验证 PostgreSQL 集成与完整回归

**Description:** 使用现有测试数据库安全 helper 和隔离 PostgreSQL，验证迁移及真实 SQL 行为，再运行服务端全量测试与类型检查。

**Acceptance criteria:**
- [ ] 测试只接受 `NODE_ENV=test` 与显式 `TEST_DATABASE_URL`，且 URL 不等于应用数据库。
- [ ] PostgreSQL 集成测试验证 migration、旧 messages 保留、摘要读写、user/project/thread 隔离及 version 冲突。
- [ ] 完整历史大小与条数限制仍然作用于原始 messages；摘要不被计入或混淆为 UI 历史。

**Verification:**
- [ ] `cd server && bun run test` 通过。
- [ ] `cd server && bun run typecheck` 通过。
- [ ] 记录 PostgreSQL 集成测试实际执行结果；不可用时明确标注未验证，不以 mock 替代数据库验证。

**Dependencies:** Tasks 1-3

**Files likely touched:**
- `server/tests/agent-threads.test.ts` 或新增集成测试
- `server/tests/support/database.ts`（仅在现有 helper 不足时）

**Estimated scope:** Medium

## Checkpoint: After Tasks 1-2

- [x] Store 单测通过。
- [x] 类型检查通过。
- [ ] 迁移集成测试和人工 schema 审查待测试库配置后完成。

## Checkpoint: Complete

- [x] 会话 store、摘要状态 CAS、历史保护及隔离 PostgreSQL 集成验收完成。
- [x] 服务端全量 138/138、类型检查及隔离 PostgreSQL 测试通过。
- [ ] 登录浏览器验证多会话完整生命周期后，sessions 用户验收关闭。
- [x] 已进入依赖本模块的 `compaction` 实现；真实账号及浏览器验收列于 `docs/content/docs/progress/pending-test.mdx`。
