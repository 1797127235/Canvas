# Spec: 画布 Agent 接入（CopilotKit / AG-UI）

状态：**已实现**（待用户实测确认）。本轮已验证：两端类型检查通过、服务端事件映射与消息映射单测 10/10、前端建图与摘要单测 8/8、`vite build` 实际产物已度量。未验证：真实模型下的流式对话与工具调用、会话刷新恢复、媒体回收衔接（需真实账号与上游）。
属 [capability-map.md](./capability-map.md) 第 12 条「Agent 交互层」边界。旧本地 Agent 已整体移除（见 `CHANGELOG.md`），本文件定义它的替代者。

本轮交付：**对话 + 看到画布 + 操作画布 + 会话持久化**，并且架构上必须为「多用户隔离」「agent 编辑画布」「agent 生成资产」留好位置——这三件事决定了下面每一个决策，不是后续再补的装饰。

## 一、目标与不变量

本轮四条（缺一不可验收）：

1. **能对话**：画布页右下角浮动按钮打开助手面板，消息流式返回。
2. **能看到画布**：模型能读到当前画布的节点、连线、选中项和可用资产摘要，回答「画布上有什么」不需要用户复述。
3. **能操作画布**：模型能一次提交一组节点与连线，落到当前画布真实 state，可保存、刷新后仍在、可撤销。
4. **会话不丢**：刷新、换标签页、换设备后对话还在，且**只有账号本人能看到**。

必须保持不变：

- 账号模式与 `VITE_AUTH_BYPASS=true` 本地模式都不受影响；Agent 只在账号模式可用（本地模式无服务端凭据，直接不渲染入口）。
- 四类生成链路（`/api/generations`）、媒体读取、工作区保存、身份模块的行为不变。媒体**回收**逻辑需要扩展（见 4.5），但只增不减。
- **`ai` 只有一份**（`ai@7.0.137`），不引入 `@copilotkit/runtime`。
- 画布节点的增删改仍然只有一条路径：`setNodes` / `setConnections`。Agent 不旁路写库、不直接改 `useCanvasStore`。

## 二、关键决策

### 2.1 只装前端 SDK，服务端按 AG-UI 契约自实现

| 包 | 位置 | 理由 |
| --- | --- | --- |
| `@copilotkit/react-core@1.79.1` | `web/` | `useAgent` / `useFrontendTool` / `useAgentContext` / `CopilotKitProvider`。React 19 在 peer 范围内。 |
| `@ag-ui/core@1.0.2` | `server/` | 事件常量与类型；无运行时依赖（peer 只有 zod，服务端已是 4.6.5）。 |
| ~~`@copilotkit/runtime`~~ | — | **不装**。直接依赖 `ai@^6.0.104` + `@ai-sdk/openai@^3`，会让服务端出现两份 `ai`；它内部只用 `streamText`/`stepCountIs`/`tool`/`jsonSchema` 四处，`ai@7` 都有。 |
| ~~`@ag-ui/encoder`~~ | — | **不装**。只多一个 `encodeSSE`，却牵进 `@ag-ui/proto`（protobuf）。SSE 帧就是 `data: <json>\n\n`。 |

`@ag-ui/*` 锁 `1.0.2`，与 `@copilotkit/react-core` 内部依赖一致；两份 `@ag-ui/client` 会导致事件对不上。

### 2.2 工具在浏览器执行，服务端只做「模型 + 事件」

AG-UI 的标准分工，也是本方案的架构前提：

```text
浏览器                               服务端
工具注册表 ──tools──▶  转成 AI SDK tool（无 execute）
                        streamText → 事件流
            ◀──tool-call──  AI SDK 在「无 execute 的工具被调用」时终止循环
handler 执行（改画布）──tool 结果──▶  下一轮 run 携带 tool 消息继续
```

因此：

- 服务端**无状态**：不跑工具、不做工具鉴权、不缓存对话内容以外的任何东西。
- 工具的权限边界来自「它只作用于当前浏览器里那份画布」；将来生成类工具走 `/api/generations`，复用现有 `requireUser` + `X-Account-Id` 校验，不新增权限层。
- 代价：每轮都要重传历史与工具结果。摘要控制在 KB 级，配合 4.4 的单会话上限，可接受。

### 2.3 会话不复用工作区文档，单独建表

`CanvasProject.chatSessions` 是旧 Agent 遗留字段，现在没有任何 UI 使用它（`project.tsx` 里只用于历史快照和媒体清理）。**不能复用它做会话持久化**，原因是写路径冲突，不是审美问题：

- `PUT /api/workspace` 是整份文档替换 + `If-Match-Version` 乐观锁。对话每来一条消息就 bump 一次工作区 version，等于**让对话和画布编辑互相 409**；用户一边拖节点一边聊天必然撞车。
- 工作区 JSON 上限 8 MiB，对话无节制增长会把画布数据一起挤到上限。

所以：**新建 `user_agent_threads` 表**（见第四节），并**删除** `CanvasProject.chatSessions` / `activeChatId` 及其在 `types/canvas.ts`、`use-canvas-store.ts`、`project.tsx` 里的全部引用。项目未上线，不需要兼容旧数据，也不留空壳字段。

### 2.4 不用 `@copilotkit/react-ui` 的现成聊天组件

`CopilotChat` / `CopilotSidebar` 自带整套样式与暗色处理，与 `canvasThemes`、`lib/app-theme.ts` 的约定冲突（AGENTS.md 禁止组件内写 `dark ? ...` 分支）。改用 headless hooks + 自绘面板。

### 2.5 面板懒加载（已实测）

`@copilotkit/react-core/v2` 的 `CopilotKitProvider` 所在入口无条件 `import "./index.css"`，并牵入 streamdown / katex / shiki / mermaid，包体很重。入口拆成两层：

- 右下角浮动按钮留在 `project.tsx`（只有图标和文案）。
- Provider 与对话 UI 放在 `canvas-agent-launcher.tsx`，由 `lazy()` 加载，只有打开助手才下载。

实测同一分支两次构建（`vite build`，minify 后 gzip 6）：

| | 产物 JS 合计 | gzip 合计 | 入口 chunk |
| --- | --- | --- | --- |
| 接入前 | 2.38 MB | 0.75 MB | 2.38 MB |
| 接入后 | 17.30 MB | 4.08 MB | 2.40 MB（未增长） |

结论：**首屏不变**（入口 chunk 没有增长），但产物体积多出约 14.9 MB / 3.3 MB gzip，绝大多数是 shiki 语言包与 mermaid（`streamdown` 的依赖），按需分块加载。第一次打开助手大约需要多下载 mermaid + 共享 vendor 两个 chunk（约 2.9 MB / 0.77 MB gzip）。镜像体积会跟着变大，这是采用 CopilotKit 前端 SDK 的实际代价，记录在此以免以后被当成回归。

不用 `/v2/context` + `CopilotKitCoreReact` 自搭 Provider：那会丢掉工具执行状态追踪（`executingToolCallIds`）等内部逻辑，第一期不值得冒这个险。

## 三、多用户与权限

Agent 引入了一条新的数据通道（对话内容 + 画布内容 → 上游模型），隔离要求比四类生成更严。逐条固定：

| 风险 | 处理 |
| --- | --- |
| 跨账号读对话 | `user_agent_threads` 一行归属一个 `user_id`，所有读写带 `WHERE user_id = $session`。查不到统一 404，不区分「不存在」与「不属于你」，避免探测。 |
| 客户端伪造 threadId | **threadId 由服务端签发**，不接受客户端自造。客户端按 `projectId` 取会话，服务端返回该 `(user, projectId)` 对应的 threadId。`run` 请求通过 `forwardedProps.projectId` 声明目标项目，服务端校验该 threadId 属于该 `(user, project)`，不匹配 409 `AGENT_THREAD_MISMATCH`。 |
| 账号切换后串号 | 面板 Provider 以 `key={user.id}` 重挂载；线程读写带 `X-Account-Id`，账号变化即 `AbortController.abort()`，与 `services/api/generation.ts` 同一套写法，服务端沿用现成的 409 `ACCOUNT_CHANGED`。 |
| 上下文泄漏别的项目 | 画布摘要只由当前页面 state 生成，只含当前项目；不读工作区全量文档。 |
| 未保存 Key 时白跑一趟 | 无 Key → 409 `API_KEY_REQUIRED`；无文本模型 → 424 `AGENT_MODEL_UNAVAILABLE`。都是中文提示，不回显上游原文。 |
| 刷对话烧钱 | 新增 rate-limit scope `agent`，**按账号**计数（现有 scope 按 IP，不适用），例如 60 次 / 5 分钟。复用 `createRateLimiter`，在 `identity/rate-limit.ts` 增加 `rateLimitUserKey` 才能按 userId 计数。 |
| 客户端塞垃圾工具定义 | `messages.ts` 对 `input.tools` 做限额：最多 32 个、名称 `^[a-zA-Z0-9_-]{1,64}$`、描述截断 1024 字、参数必须是可转换的 JSON Schema；不合格的工具直接丢弃，不报错（丢工具比整轮失败好）。 |
| 对话内容进审计日志 | 沿用现有审计（`app.ts` 的 `logRequests`，请求体 16 KiB 截断），与生成请求同等对待，不额外处理、也不额外豁免。 |

## 四、会话持久化

### 4.1 表

```sql
-- server/sql/011-agent-threads.sql
CREATE TABLE IF NOT EXISTS user_agent_threads (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    thread_id UUID NOT NULL,
    version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
    messages JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS user_agent_threads_thread_idx ON user_agent_threads(thread_id);
```

- **主键是 `(user_id, project_id)`**，不是 threadId：会话是画布项目的属性，一个项目一条会话（本轮不做多会话列表）。`thread_id` 只是给 AG-UI 用的标识，服务端签发。
- `messages` 存**原样的 AG-UI `Message[]`**，不转成自定义结构：刷新后直接回填 `agent.setMessages(...)`，工具调用与结果一起还原；AG-UI 版本升级时只需处理未知字段，不需要重写映射。
- 为什么不按消息一条一行：一轮对话的消息数是几十到几百量级，整行重写在 KB～百 KB 级；拆表带来分页/裁剪/排序三层逻辑，本轮不值得。

### 4.2 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/agent/threads/:projectId` | 没有则创建并返回 `{ threadId, version, messages }` |
| `PUT` | `/api/agent/threads/:projectId` | 带 `If-Match-Version`，整体保存 `{ messages }`，返回新 `version` |
| `DELETE` | `/api/agent/threads/:projectId` | 「新对话」：清空消息并换新 `thread_id` |

冲突返回 409 `AGENT_THREAD_CONFLICT`，前端提示「对话已在其他页面更新」——与工作区 409 同一套交互。

### 4.3 上限

单会话 `messages` 序列化后上限 **2 MiB**、消息条数上限 **400**。超限返回 413 `AGENT_THREAD_TOO_LARGE`，前端提示开新对话。

**不静默裁剪历史**：按 AGENTS.md 的原则，宁可让用户开新会话，也不偷偷丢消息——丢了之后模型会基于残缺上下文回答，比报错更糟。

### 4.4 生命周期

- 删除画布项目 → 该项目的 thread 变成孤儿。在 `PUT /api/workspace` 已有的引用重建同一个 pass 里清理：`DELETE FROM user_agent_threads WHERE user_id = $1 AND NOT (project_id = ANY($2))`。项目列表从文档里读，所以永远能对齐。
- 删除账号 → `ON DELETE CASCADE`，无需额外处理。

### 4.5 与媒体回收的衔接（不处理就会坏）

`clearUnusedMedia`（`server/src/media.ts`）现在只查三处引用：`user_media_references`、`user_workspaces.data`、`user_generation_history.data`。对话里一旦出现 `remote:<uuid>`（本轮就会：`apply_graph` 允许引用已有资产；下一轮生成工具会往消息里写生成结果），**这些媒体会在 7 天后被回收，对话里的图片变空**。

所以必须补第 4 个检查：

```sql
AND NOT EXISTS (SELECT 1 FROM user_agent_threads t
                WHERE t.user_id = m.user_id
                  AND t.messages::text LIKE '%remote:' || m.id::text || '%')
```

同时 `PUT /api/agent/threads/:projectId` 保存成功后，把该会话里的 `remote:` 引用并入 `user_media_references`（与工作区同一套整体重建，不写增量）。这样引用表、三处原文扫描、回收任务三者继续一致。

## 五、目标架构

```text
web/src/pages/canvas/project.tsx
  nodes / connections / selectedNodeIds / setNodes / setConnections   ← 唯一权威 state
  agentWrite（写入接口，见 6.3）                                        ← 所有 agent 写操作的唯一出口
        │ props
        ▼
  lazy → components/canvas/canvas-agent-launcher.tsx   右下角浮动按钮 + 浮动面板
            CopilotKitProvider(runtimeUrl="/api/copilotkit",
                               credentials="same-origin",
                               headers={X-Account-Id}, properties={{ projectId }})
              ├─ useAgentContext   ← canvas + assets + selection 三段摘要
              ├─ useFrontendTool   ← 注册表逐条注册（本轮只有 apply_graph）
              ├─ 事件回灌队列       ← 生成完成等异步结果（本轮留接口）
              └─ 对话 UI（消息流 / 输入 / 工具气泡 / 确认卡片，走 canvasThemes）
                        │ POST /api/copilotkit/agent/default/run  (SSE)
                        ▼
server/src/agent/routes.ts  createAgentRouter({ database, catalog, encryptionKey, limiter })
        ├─ /info
        ├─ /agent/:agentId/run   requireUser → 限流 → 校验 thread↔project → 解析文本模型
        └─ /threads/:projectId   GET / PUT / DELETE（归属校验 + 上限）
                        ▼
server/src/agent/run.ts     RunAgentInput → ModelMessage[] → streamText(ai@7) → fullStream
        ├─ messages.ts      AG-UI Message/Tool → AI SDK 类型（纯函数）
        └─ events.ts        fullStream part → AG-UI 事件 + SSE 帧（纯函数）
                        ▼
            账号自己的上游（同一把 Key、同一个 baseUrl，与四类生成同源）
```

## 六、文件组织

### 6.1 服务端（新建 `server/src/agent/`，与 `identity/`、`catalog/` 同级）

不塞进 `ai/`：`ai/` 是四类生成的适配层，语义不同。

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `routes.ts` | 两个 run 路由 + 三个 thread 路由；鉴权、限流、thread↔project 校验、SSE 响应头与断开处理 | express、`requireUser`、`readUserCredential`、`accountModels` |
| `run.ts` | 一次 run 的编排：输入 → `streamText` → 逐事件写出 | `ai`、`messages`、`events` |
| `messages.ts` | AG-UI `Message[]` → `ModelMessage[]`；`Tool[]` → 无 `execute` 的 `ToolSet`（含限额与名称校验）；预留 media reader 注入位（将来让模型看到生成结果） | 纯函数 |
| `events.ts` | `fullStream` part → AG-UI 事件；SSE 帧编码 | 纯函数 |
| `threads.ts` | thread 仓储：ensure/get/save/rotate + 归属与上限校验 + 媒体引用并入 | `pg`、`withTransaction` |

改动：

- `server/src/index.ts`：增加一行挂载 + 启动时确保 `011` 已跑（参与现有 SQL 清单）。
- `server/src/media.ts`：`clearUnusedMedia` 增加 `user_agent_threads` 检查（4.5）。
- `server/src/identity/rate-limit.ts`：新增 `agent` scope 与 `rateLimitUserKey`。
- `server/sql/011-agent-threads.sql`：新建。

`messages.ts` / `events.ts` 保持纯函数是刻意的：映射表是最容易出错的地方，必须能脱离网络单测。

### 6.2 前端

| 文件 | 状态 | 职责 |
| --- | --- | --- |
| `components/canvas/canvas-agent-launcher.tsx` | 新建 | 懒加载入口（默认导出）。Provider + 上下文 + 工具注册 + 对话 UI。接收 `projectId` / `nodes` / `connections` / `selectedNodeIds` / `onClose` / `onApplyGraph`。 |
| `lib/canvas/canvas-agent-context.ts` | 新建 | 纯函数：`canvas` / `assets` 两段摘要（见 7.1）。 |
| `lib/canvas/canvas-agent-graph.ts` | 新建 | `apply_graph` 的入参 schema（zod）与实现：节点生成（复用 `createCanvasNode`）、连线校验、布局计算、警告收集。纯函数。 |
| `services/api/agent.ts` | 新建 | thread 的 GET/PUT/DELETE 封装：`X-Account-Id`、`If-Match-Version`、账号切换 abort、409/413 映射成可读错误。 |
| `pages/canvas/project.tsx` | 改动 | 渲染右下角浮动按钮 + `lazy()` 加载 launcher；移除 `chatSessions` / `activeChatId` 相关 state、历史快照与保存逻辑。 |
| `pages/canvas/hooks/use-canvas-agent-actions.ts` | 新建 | agent 写画布的回调集合（`applyGraph` / `updateNode` / `removeNodes` / `connectNodes` / `disconnectNodes`），唯一写入出口。 |
| `pages/canvas/hooks/use-agent-sidebar-width.ts` | 新建 | 助手面板宽度 state 与左边界拖拽。 |
| `stores/canvas/use-canvas-store.ts`、`types/canvas.ts` | 改动 | 移除 `chatSessions` / `activeChatId` / `CanvasAssistantSession` / `CanvasAssistantMessage` 等死字段与类型。 |
| `i18n/locales/zh-CN.ts` | 改动 | 面板与错误文案。 |

`lib/canvas/` 下三个纯函数都要能被 `bun test` 直接覆盖，和现有 `canvas-node-geometry.ts` 同一类。

## 七、契约细节

### 7.1 上下文：两段

```text
当前画布                      → nodes[]（id/类型/标题/位置/尺寸/状态/prompt 前 120 字/hasMedia）、connections[]、selectedNodeIds[]
资产库（建节点时可用 storageKey）→ assets[]（最多 40 条，只给 kind/title/storageKey）、total
```

摘要不给 `content` 全文、base64、`images` 数组、`references` 明细，以控制上下文预算；需要详情时由 `get_node_detail` 按需读取文本节点内容，不返回媒体正文。

资产单独成一段是因为 `apply_graph` 的 `storageKey` 要能用：模型得知道有哪些现成素材可以引用。

### 7.2 布局由代码算，不由模型算

`apply_graph` **不接受坐标**。`createCanvasNode` 会把传入坐标当中心点（内部 `x - width/2`），模型既不知道视口大小也不知道已有节点占位，让它编坐标必然重叠。

规则：从当前视口中心起算，沿已有节点包围盒右边缘向右排布，间距固定；同批节点按声明顺序横向排列。模型只决定「加什么节点、什么关系」。

### 7.3 写入出口 `useCanvasAgentActions`：所有 agent 写操作的唯一通道

```ts
// pages/canvas/hooks/use-canvas-agent-actions.ts
export function useCanvasAgentActions({ nodesRef, connectionsRef, setNodes, setConnections, setSelectedNodeIds, getCanvasCenter, deleteNodes }) {
    const applyGraph = useCallback((input: ApplyGraphInput): AgentGraphResult => {
        const result = buildAgentGraph(input, nodesRef.current, getCanvasCenter());
        if (result.nodes.length) { setNodes(...); setConnections(...); setSelectedNodeIds(...); }
        return result;
    }, [...]);
    return { applyGraph, updateNode, removeNodes, connectNodes, disconnectNodes };
}
```

- 由 `pages/canvas/hooks/use-canvas-agent-actions.ts` 实现，内部走 `setNodes` / `setConnections`，与手工操作同一条路径。
- 读当前节点与连线一律走 `nodesRef` / `connectionsRef`，不用 state：这些回调是前端工具注册的依赖，引用一变就会重新注册工具，走 ref 才能保持引用稳定。
- 撤销：历史 effect 已经在监听 `nodes` / `connections`，一次工具调用写入后自动形成一个撤销单元，不需要额外接线。
- 加新写工具时不新开写入通道：在 `use-canvas-agent-actions.ts` 增加方法，在 `components/canvas/tools/` 注册前端工具；所有写入仍进入画布现有 state 与撤销/保存路径。

### 7.4 `apply_graph`

```text
apply_graph({ nodes: [{ key, type, title, prompt?, content?, storageKey? }], connections: [{ from, to }] })
```

- `key` 是批内临时标识，用于表达连线；返回映射成真实节点 id。
- `storageKey` 允许 `remote:<uuid>`（引用已有资产 / 生成结果），服务端媒体归属校验照旧。
- 拒绝：`type` 不在 `listNodeDefinitions()`、连线引用不存在的 `key`、自环。
- 返回 `{ created: [...], warnings: [...] }`，**警告不回滚整批**（一个节点不合法不该让其余节点白建），但会在工具结果里明确告诉模型哪几条被拒。

### 7.5 ai@7 的一个硬性要求（实现时才知道）

`ai@7` 的类型里，**没有 `execute` 的工具必须声明 `outputSchema`**（`ToolOutputProperties` 的第二个分支）。少写这个字段 `tsc` 直接报错。工具的实际输出形状对我们没有意义（结果由下一轮消息带回），所以统一给宽松对象 `{ type: "object", additionalProperties: true }`。`@copilotkit/runtime` 用 `ai@6` 时才不需要这个字段——这是不装 runtime 的连带成本，已记在 `messages.ts` 注释里。

### 7.6 已实现的执行许可（原「为生成资产预留的 seam」）

工具不再「注册即执行」：全部经 `use-gated-tool.ts` 注册，按 `read` / `write` / `spend` 分级，三档模式（只读 / 每次询问 / 自动执行）决定直接执行、弹审批卡片或拒绝；`spend` 不受模式影响，最宽只到本次会话放行。完整规则见 [agent-tool-approval.md](./agent-tool-approval.md)。生成类工具接入时只需声明 `risk: "spend"`，不再单独实现确认弹窗。

仍未实现的 seam：**异步回灌队列**——生成类工具立即返回 `{ taskId, nodeId }`，不阻塞对话；任务完成由现有轮询发现，完成事件推入队列，面板把它作为一条消息注入下一轮。本轮仍未接入任何产生方。

## 八、本轮不做

- 多会话列表 / 会话标题自动生成（一个项目一条会话）。
- `STATE_SNAPSHOT` 双向同步（画布摘要单向传给模型足够）。
- 生成类工具（`generate_node` 及执行前确认）；基础节点读取、修改、删除和连线工具已实现。
- 意图理解、模板检索、能力目录、参数归一（长期目标，见第十节）。
- 服务端 `AgentRunner`／断点续跑（客户端每次全量重传，不需要）。
- 不引入 `@copilotkit/runtime`、`@ag-ui/encoder`、`@copilotkit/react-ui`；不恢复旧 Agent 面板、Store、Canvas Bridge、命令总线。

## 九、验收方式

每层可独立验证，不必等整套跑通：

| 层 | 验证 | 状态 |
| --- | --- | --- |
| 事件映射 | `server/tests/agent-events.test.ts`：5 条，覆盖文本/工具调用/参数补齐/流错误与工具错误/SSE 帧 | 已通过 |
| 消息与工具转换 | `server/tests/agent-messages.test.ts`：5 条，覆盖 prompt 拼接、tool 消息反查工具名、多模态保留、无 `execute` 注册、工具数量上限 | 已通过 |
| 上下文与建图 | `web/tests/canvas-agent-graph.test.ts`：8 条，覆盖布局不重叠、避让既有内容、连线映射、非法 type 跳过、`remote:` 转 url、入参校验、摘要不泄漏正文、资产上限 | 已通过 |
| 存量回归 | `web bun test` 52/52；`server` 非数据库用例 14/14（数据库集成用例需要本地 `TEST_DATABASE_URL` 指向的实例，本机未启动，未跑） | 已通过 / 部分 |
| 类型检查 | `web` 与 `server` 的 `tsc --noEmit` 均通过 | 已通过 |
| 包体 | `vite build` 同一分支两次构建对比，见 2.5 | 已度量 |
| 路由 | `curl`：`/info` 返回 agent；`/run` 收到 SSE；未登录 401；无 Key 409；无文本模型 424；别人的 projectId 404 | **未验证** |
| 对话 | 打开助手，一问一答，文字流式出现 | **未验证** |
| 看到画布 | 问「画布上有几个节点、分别是什么」，答案与画布一致 | **未验证** |
| 操作画布 | 说「加一个文本节点写夕阳」，节点出现、可保存、刷新后仍在、可撤销 | **未验证** |
| 会话持久 | 刷新后面板对话仍在；换浏览器登录同一账号仍在；换账号看不到 | **未验证** |
| 回收衔接 | 对话里引用 `remote:` 素材后，跑一次 `clearUnusedMedia`，该媒体不被删 | **未验证** |

未验证的六项都需要真实账号与上游模型，是下一步实测的第一批内容（见 `pending-test.mdx`）。

## 十、后续阶段（不在本轮，但架构已为其留位）

1. **生成资产**：`generate_node` 走 `/api/generations`（复用账号 Key 与现有四类链路），异步返回 `taskId`，用 7.5 的回灌队列把结果告诉模型；`confirm: true` 让用户先确认再花钱。
2. **能力目录**：把 `gateway-video.ts` / `input.ts` 里的参数约束提成数据接口，让模型规划出的参数合法，减少「第一跑就报错」。
3. **模板检索**：把 `web/public/templates/templates.json` 暴露成可检索能力，作为人工调通的「配方库」。
4. **意图 → 方案 → 确认 → 建图**：真正降低创作门槛的那一步，依赖能力目录与模板检索。
5. **多模态**：让模型「看到」画布图片与生成结果——`mediaReader` 已能把 `remote:<id>` 转 data URL，`messages.ts` 预留了注入位。助手输入框的图片附件已按这条路径落地（见 `agent-attachments.md`）；画布节点图片仍待接入。
6. **多会话 / 跨端续聊**：`user_agent_threads` 主键改为 `(user_id, project_id, thread_id)`，加会话列表。
