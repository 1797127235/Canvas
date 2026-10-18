# Spec: Agent 会话压缩状态存储（sessions）

状态：**已批准**。属于 [agent-context-compression-capability-map.md](./agent-context-compression-capability-map.md) 的 `sessions` 模块，是 `compaction` 模块的前置依赖。

## Objective

为每个 Agent 会话持久化完整消息历史，以及服务端生成的压缩摘要和摘要覆盖边界。压缩状态用于后续模型请求构造，但不替换 UI 使用的完整历史，也不允许浏览器写入摘要。

成功后应满足：

- 刷新、切换设备后，完整消息历史和已提交的压缩状态均可恢复。
- 会话消息 CRUD 继续按账号、项目和 thread 隔离，并保留现有乐观锁语义。
- 会话读取方可以分别取得完整历史和供 compaction 使用的已提交摘要状态。
- 浏览器保存消息时不能覆盖、伪造或清空服务端摘要状态。
- 摘要状态更新与消息版本并发冲突时，不得静默覆盖另一方的数据。

## Tech Stack

- Node.js 24、TypeScript、Express、PostgreSQL。
- AG-UI `Message` 消息类型；现有服务端测试使用 Node.js `node:test`，通过 `tsx` 执行。
- 不新增依赖。

## Commands

从 `server/` 目录执行：

```bash
bun run test
bun run typecheck
```

涉及 SQL 迁移时，还需在配置好的测试 PostgreSQL 数据库执行迁移与会话存储集成测试。测试数据库配置及启动命令由实现任务按现有仓库测试设施填写；不得以未配置数据库作为迁移已验证的证据。

## Project Structure

```text
server/src/agent/sessions/
  store.ts       会话历史和压缩状态的持久化访问
  types.ts       会话及压缩状态类型（只有确有跨文件需要时再拆分）
server/sql/     新增会话存储字段迁移
server/tests/   会话存储、并发和权限边界测试
```

HTTP 路由仍由 `server/src/agent/routes.ts` 管理；模型上下文裁剪、压缩触发和摘要生成不属于本模块。现有 `threads.ts` 的 CRUD 将在实施时按本规格迁入 `sessions/`，调用方只通过明确的 store 接口访问，不保留平行的旧实现。

## Code Style

沿用现有参数化 SQL、账号/项目/thread 复合归属条件和乐观锁写法。浏览器可写消息，服务端专用方法可写摘要状态，两种写入接口分离：

```ts
saveMessages(userId, projectId, threadId, expectedVersion, messages)
updateCompactionState(userId, projectId, threadId, expectedVersion, state)
```

以上仅展示接口边界，最终签名需满足现有 store 和数据库约束；客户端请求 schema 不得包含摘要字段。

## Testing Strategy

- 单元测试验证消息格式/容量约束、压缩状态字段规则和更新冲突行为。
- PostgreSQL 集成测试验证迁移、完整历史保留、摘要状态独立写入、账号/项目/thread 隔离及乐观锁冲突。
- 路由测试验证客户端不能通过消息保存接口写入摘要字段。
- 运行 `bun run test` 与 `bun run typecheck`；迁移相关测试必须使用测试数据库实跑。

## Boundaries

- Always: 保留完整原始消息；所有读写以 user、project、thread 三者校验归属；摘要状态只能由服务端专用接口更新；更新使用乐观锁；消息存储版本与 AG-UI 通信协议版本分开管理。
- Ask first: 改变完整消息历史的保留方式；改变公开 HTTP 会话契约；新增依赖；引入会话记录删除或归档策略。
- Never: 把摘要作为唯一历史；让浏览器提交可信摘要或摘要边界；发生版本冲突时覆盖数据；把压缩摘要混入当前画布状态快照。

## Success Criteria

- 会话持久化层能够保存并读取完整消息历史与服务端压缩状态，二者互不覆盖。
- 现有会话 CRUD 的账号、项目、thread 隔离和并发版本保护保持有效。
- 客户端消息保存不能写入或清空摘要状态。
- 摘要状态更新冲突会明确失败，且不会丢失原有历史或摘要。
- 相关迁移、单元测试、PostgreSQL 集成测试、类型检查通过。

## 已确认设计决策

- 压缩边界使用稳定的 `messageId`；压缩覆盖到该消息为止，具体消息分组与合法切点由 `compaction` 规格定义。
- 首版只保存当前摘要及其覆盖边界；完整原始消息仍保留在 `messages`。
- 摘要更新和消息更新共用会话 `version`，每次成功写入都递增，并使用乐观锁拒绝并发覆盖。

## Open Questions

1. 现有服务端测试 PostgreSQL 的连接配置和迁移测试约定是什么？实现前需核对并明确。

## Related

- 上游已批准能力地图：[agent-context-compression-capability-map.md](./agent-context-compression-capability-map.md)
- 现有 Agent 接入规格：[agent-copilotkit.md](./agent-copilotkit.md)
