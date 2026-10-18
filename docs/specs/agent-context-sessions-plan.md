# Implementation Plan: Agent Context Sessions

状态：**待评审**。对应 [agent-context-sessions.md](./agent-context-sessions.md) 的 `sessions` 模块；上游能力地图：[agent-context-compression-capability-map.md](./agent-context-compression-capability-map.md)。

## Overview

将当前 Agent 会话持久化代码整理到 `server/src/agent/sessions/`，并为每个会话增加由服务端维护的当前摘要和稳定消息 ID 边界。完整 `messages` 保持原样供 UI 使用；浏览器只能更新消息，不能写摘要。摘要更新与消息更新共用会话版本并通过乐观锁保护。

## Architecture Decisions

- `sessions/` 成为会话数据访问唯一实现；路由保留在 `agent/routes.ts`，模型消息准备仍由现有 agent run 层负责。
- 数据库仅新增当前摘要、边界消息 ID 两个字段；首版不保留摘要历史版本，完整消息仍是审计和 UI 权威记录。
- 摘要状态更新通过服务端内部 store 方法完成，不增加客户端 HTTP 写摘要接口。
- 消息和摘要写入均递增同一个 `version`；任一并发旧版本写入返回明确冲突，调用方重新读取后再决策。
- 数据库变更使用新的顺序 SQL 迁移，更新启动迁移注册；消息存储格式版本与 AG-UI 协议版本保持独立。
- 测试数据库必须通过 `NODE_ENV=test` 与显式 `TEST_DATABASE_URL`，并由现有 helper 确保不指向应用数据库。

## Dependency Graph

```text
SQL migration + row shape
        ↓
sessions store and types
        ↓
HTTP routes keep client message-only contract
        ↓
unit + PostgreSQL integration verification
```

## Task List

详见 [agent-context-sessions-todo.md](./agent-context-sessions-todo.md)。任务顺序：迁移 → store → 路由与消息接口边界 → PostgreSQL 集成和全量验证。

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| 摘要边界对应的消息缺失或不属于该会话 | 高：后续可能错误跳过历史 | store 校验边界消息 ID 存在于同一会话完整消息内；否则拒绝写入 |
| 消息保存与摘要更新并发 | 高：覆盖摘要或消息 | 共用版本号与原子条件更新；冲突不自动重试覆盖 |
| 用户现有会话改动尚未提交 | 高：误覆盖既有实现 | 迁移前逐文件阅读当前工作区版本，只做必要的移动和增量修改，不重置或覆盖用户修改 |
| SQL 迁移本地测试环境缺失 | 中：不能证明 schema 可运行 | 使用显式隔离测试库执行迁移和集成测试；未运行时明确标记未验证 |

## Verification Checkpoints

### After Tasks 1-2

- [ ] 迁移幂等，store SQL 与新 schema 一致。
- [ ] Store 单测覆盖消息保存、摘要写入、无效边界和乐观锁冲突。
- [ ] `cd server && bun run typecheck` 通过。

### Complete

- [ ] 路由客户端契约不接受摘要字段，现有会话 CRUD 权限隔离保持。
- [ ] 隔离 PostgreSQL 集成测试覆盖迁移、历史保留、摘要独立读写、归属和冲突。
- [ ] `cd server && bun run test` 及 `cd server && bun run typecheck` 通过。
- [ ] 审查 git diff，确认没有覆盖用户未提交改动或引入无关重构。

## Open Questions

- 无新增产品决策。PostgreSQL 集成测试执行环境需在实施时确认可用性；测试 URL 必须与应用数据库不同。
