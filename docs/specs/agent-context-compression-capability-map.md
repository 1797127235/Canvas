# Capability Map: Agent 上下文压缩

状态：已批准。按依赖顺序分别编写模块规格。

|Module id|Responsibility|Depends on|
|---|---|---|
|`sessions`|管理 Agent 会话消息及服务端维护的压缩状态|—|
|`compaction`|评估上下文预算、选择压缩边界、生成摘要并构造送模上下文|`sessions`|

构建顺序：`sessions` → `compaction`

规格入口：[`sessions`](./agent-context-sessions.md)（已批准，集成验收未完成）；[`compaction`](./agent-context-compaction.md)（草案，待评审）。

## 边界

- 压缩只改变送给模型的消息投影，不删除或改写 UI 展示的完整消息历史。
- 摘要和边界由服务端管理，客户端不得提交或覆盖。
- 工具调用与对应工具结果必须作为完整单元保留或压缩。
- 当前画布与素材上下文每轮动态提供，不合并进持久化会话摘要。
- 两个模块的规格分别评审；`compaction` 依赖已批准的 `sessions` 数据接口。
