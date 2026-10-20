# 规格：画布助手的工具执行许可

状态：已实现（阶段 1–6）。前端类型检查、`web/tests/tool-approval.test.ts` 7/7、前端全量 78/78 与生产构建通过；登录浏览器人工验收见 `docs/content/docs/progress/pending-test.mdx`。

## 目标与范围

助手的工具从「可撤销的画布写入」扩展到「花用户钱的上游生成」之前，需要一个与具体工具解耦的执行许可层：哪些工具可以直接跑、哪些必须用户点确认、哪些永远不许跑。

对齐 coding agent 的常见形态：模式开关 + 单工具记住选择 + 危险操作永远询问。

本轮范围：

- 工具风险分级，作为工具声明的一部分集中定义。
- 三档执行模式（只读 / 每次询问 / 自动执行）。
- 单工具「始终允许 / 始终拒绝」覆盖，可随时重置。
- 面板内的审批卡片。
- 所有拒绝路径都返回结构化结果，不挂起、不抛错。

不做：额度与成本上限、按项目/按节点的细粒度权限、服务端权限校验、审批历史持久化。

## 为什么现在做

现有 6 个工具（`apply_graph`、`get_node_detail`、`update_node`、`delete_nodes`、`connect_nodes`、`disconnect_nodes`）全部无条件执行。它们都是可撤销的，代价可控，所以现在没问题。

但这个假设下一轮就不成立了：`generate_image` / `generate_video` 花的是用户自己的钱，一次视频几块到几十块，且**不可撤销**。如果继续用「注册即执行」的写法，模型一句「我帮你生成一下」就直接扣费。等到写生成工具时再补这层，会同时改注册方式、UI 和提示词，改动面更大。

## 已核实的前置事实

设计依赖 CopilotKit v2 的三处行为，均已在本机 `@copilotkit/react-core@1.79.1` / `@copilotkit/core` 源码中确认：

1. **客户端不校验工具入参**。`@copilotkit/core` 的 `parseToolArguments` 只做 `JSON.parse` + `ensureObjectArgs`；`parameters` 的 zod schema 只被转成 JSON Schema 发给模型。许可层判断之前必须自己 `parse`。
2. **`FrontendTool.available` 可以隐藏工具**（`node_modules/@copilotkit/core/dist/index.d.mts:139`）：`available: false` 时工具不出现在模型的工具列表里，但保持注册。这正是「始终拒绝」的正确实现方式——模型根本看不到它，不会反复尝试。
3. **未回答的工具调用会污染后续 run**。`reconnectBehavior` 默认 `"passive"`，刷新后不会重跑 handler；但如果一轮里还有别的工具没拿到结果，下一次 follow-up run 会带上这个空结果调用，部分上游直接 400。**所以拒绝必须返回一个正常结果，不能挂起或抛错**。
4. **`handler(args, context)` 的 `context.signal`** 在 `stopAgent()` 时中止，`context.isReplay` 标记历史重放。审批等待必须监听 `signal`，否则停不掉。
5. **面板是自绘消息列表**，不经过 `CopilotChat` 渲染层。`useHumanInTheLoop` 的 `render` 不会显示，所以审批 UI 必须自己做。

## 风险分级

在工具声明处写死，不由用户改分类，也不由模型决定：

| 等级 | 含义 | 工具 |
| --- | --- | --- |
| `read` | 只读，无副作用 | `get_node_detail`、未来的 `list_models` / `search_templates` |
| `write` | 改画布，可撤销，代价低 | `apply_graph`、`update_node`、`delete_nodes`、`connect_nodes`、`disconnect_nodes` |
| `spend` | 花用户钱、不可撤销或撤销也退不回费用 | 未来的 `generate_image` / `generate_video` / `generate_audio` |

新工具必须显式声明等级，没有默认值——漏写就类型报错，避免以后新加的工具悄悄落到宽松档。

## 执行模式

三档，用户可切换，**`spend` 不受模式影响**：

| 模式 | `read` | `write` | `spend` |
| --- | --- | --- | --- |
| `read-only` 只读 | 自动 | 拒绝 | 拒绝 |
| `ask` 每次询问（默认） | 自动 | 询问 | 询问 |
| `auto` 自动执行 | 自动 | 自动 | 询问 |

关键取舍：

- **`spend` 永远询问**，不提供「自动扣费」模式。用户说「直接生成」时，由模型在参数里表达意图，仍过一次确认；确认卡片可以给出「本次会话都允许图片生成」，但仅限图片、仅限本会话。
- **`read-only` 默认拒绝而不是隐藏**。拒绝会返回「当前是只读模式，请在设置里切换到允许执行」，模型能据此告诉用户怎么改；隐藏则让模型以为工具不存在，可能反复用别的方式绕。
- 模式是设备级偏好，跟主题一样，不跟账号走。项目尚未上线，不需要按账号同步。

## 数据模型

```ts
type ToolRisk = "read" | "write" | "spend";
type ApprovalMode = "read-only" | "ask" | "auto";
type ToolPolicy = "always" | "never";   // 缺失 = 跟随模式

// web/src/stores/use-agent-permission-store.ts
type AgentPermissionState = {
    mode: ApprovalMode;
    overrides: Record<string, ToolPolicy>;
    sessionAllow: Record<string, true>;  // 本会话「都允许」，不持久化
    setMode(mode: ApprovalMode): void;
    setOverride(tool: string, policy: ToolPolicy | undefined): void;
    allowForSession(tool: string): void;
    reset(): void;
};
```

- `overrides` 持久化到 `localforage`（走现有 `localForageStorage`，与 `use-asset-store` 同一条路），体积极小。
- `sessionAllow` 只放内存，刷新即失效。花钱类工具的「本次会话都允许」放这里。

## 决策函数

抽成纯函数，便于单测，也便于以后在服务端复用同一份规则：

```ts
// web/src/lib/agent/tool-approval.ts
export function resolveToolGate(input: {
    risk: ToolRisk;
    mode: ApprovalMode;
    override?: ToolPolicy;
    sessionAllowed?: boolean;
}): "allow" | "ask" | "deny" | "deny-readonly";
```

判定顺序（顺序本身是规格的一部分）：

1. `override === "never"` → `deny`
2. `risk === "read"` → `allow`
3. `mode === "read-only"` → `deny-readonly`
4. `override === "always"` → `allow`
5. `risk === "spend"` → `sessionAllowed ? "allow" : "ask"`
6. `mode === "auto"` → `allow`
7. → `ask`

注意第 1 条压过第 2 条：用户明确禁止过的只读工具也不再自动跑。第 4 条压过第 5 条：用户为某个花钱工具单独开了「始终允许」，就不再每次问。

## 注册方式

统一收口到一个包装 hook，现有工具全部改走它：

```ts
// web/src/components/canvas/tools/use-gated-tool.ts
useGatedTool(
    { name, description, risk, parameters, handler },
    deps,
);
```

内部职责：

1. `resolveToolGate` 决定动作。
2. `deny` / `deny-readonly` → 立即返回 `{ status: "denied", reason }`，**不调用 handler**。
3. `ask` → 把请求放进审批队列，`await` 用户决定；用户允许后再调 handler。
4. `allow` → 直接调 handler。
5. `available` 由 `override !== "never"` 推导，交给 `useFrontendTool`。

返回值语义统一，模型侧只需要认 `status`：

```text
{ status: "ok", ...业务结果 }
{ status: "denied", reason: "用户拒绝了这次操作" }
{ status: "denied", reason: "当前是只读模式，可让用户在助手设置里切换为允许执行" }
{ status: "cancelled", reason: "用户取消了等待" }
```

## 审批 UI

面板内联卡片，渲染在消息列表底部、输入框上方。理由：面板是自绘的，`useHumanInTheLoop` 的 `render` 不可用；内联卡片还能天然支持一次 run 里连续多个待审批调用。

单个待审批项：

```text
┌──────────────────────────────────────┐
│ 助手想修改节点                        │
│ 「文本-夕阳」→ 内容改为“黄昏时分的海面” │
│ [允许一次] [始终允许] [拒绝]           │
└──────────────────────────────────────┘
```

- 摘要文案按工具生成人话，不直接甩 JSON。`spend` 类必须显示模型、张数/时长等花钱项。
- 一次 run 出现多个待审批调用时，按顺序排队，一次展示一个；顶部显示「还有 N 个待确认」。
- `spend` 类的第二个按钮是「本次会话都允许图片生成」这种带范围的文案，不是无限期。
- 队列清空后不保留历史，审批结果由 tool 消息本身记录（已经在内联卡片之外可见）。

## 生命周期与边界

| 场景 | 行为 |
| --- | --- |
| 用户点「拒绝」 | 立即返回 `denied`，模型下一轮照常继续 |
| 用户点关闭面板 / 切换会话 | 所有待审批项按 `cancelled` 返回，run 正常收尾，不留未回答的工具调用 |
| `stopAgent()` | 监听 `context.signal`，中止等待并按 `cancelled` 返回 |
| 刷新页面 | `reconnectBehavior` 默认 `passive`，不重跑 handler（正确：不恢复执行） |
| 未登录 / 无模型 | 与权限层无关，沿用现有错误路径 |

面板在 `agent.isRunning` 时禁用了关闭/切换按钮，因此「关闭面板时仍有待审批项」在实践中不会发生；但代码仍要兜住，因为 `stopAgent` 和浏览器返回键绕得过 UI。

## 系统提示词

`server/src/agent/run.ts` 的 `INSTRUCTIONS` 增加：

- 工具可能被用户拒绝；收到 `denied` 时如实告知用户被拒的原因，不要换个参数重试，除非用户明确要求。
- 收到 `cancelled` 时不要认为操作已完成。
- 花钱的操作先说明要做什么、大概花多少，再调用工具。

## 实施顺序

| 阶段 | 内容 |
| --- | --- |
| 1 | `tool-approval.ts` 决策纯函数 + 单测（模式 × 风险 × 覆盖的完整矩阵） |
| 2 | `use-agent-permission-store.ts`（mode / overrides / sessionAllow） |
| 3 | `use-gated-tool.ts` 包装 hook + 审批队列（Promise 挂起/唤醒） |
| 4 | 现有 6 个工具改走 `useGatedTool`，声明风险等级；`use-apply-graph-tool.ts` 一并迁移后删除 |
| 5 | 面板审批卡片 + 设置入口（面板头部 Dropdown 加「执行权限」子菜单，含重置） |
| 6 | 系统提示词补充拒绝语义 |
| 7 | 文档：`agent-copilotkit.md` §7.3 / 第八节、`pending-test.mdx`、`CHANGELOG.md` |

阶段 1–3 全部是纯前端、无 UI 依赖，可以先落地并单测；4 之后才需要人工验收。

## 顺带修掉的问题

`web/src/components/canvas/tools/use-canvas-tools.ts` 里 5 个 handler 都没有 `parse` 入参，直接按 TS 类型信任参数。由于 CopilotKit 不校验（见前置事实 1），`updateCanvasNodeInput` 的 `refine`（至少给一个字段）从未执行。`useGatedTool` 应在调用 handler 前统一 `parse` 一次，失败返回 `{ status: "denied", reason: "参数不合法：…" }`，不执行副作用。

## 测试计划

纯函数（`web/tests/`，无需浏览器）：

- `resolveToolGate` 全矩阵：3 模式 × 3 风险 × {无覆盖, always, never} × {sessionAllowed}。
- 优先级：`never` 压过 `read` 自动；`always` 压过 `spend` 询问；`read-only` 下 `always` 不生效（只读模式优先于单工具放行）。
- 参数校验失败不执行 handler。

人工验收（登录浏览器）：

- `ask` 模式下让助手改节点，弹出卡片，拒绝后画布无变化且助手说明被拒。
- `auto` 模式下同样的操作不弹卡片，直接生效，Ctrl+Z 可撤销。
- `read-only` 模式下助手说改不了，切回 `ask` 后能改。
- 设为「始终拒绝」后模型不再尝试该工具（工具已从列表移除）。
- 审批等待中点停止，卡片消失，助手没有谎称已完成。
- 生成类工具接入后：`auto` 模式下图片仍弹确认。

## 不做

- 成本额度与单次花费上限（生成工具落地后再单独设计）。
- 服务端权限校验（工具只在浏览器执行，服务端不参与）。
- 按项目、按节点、按时间窗口的细粒度策略。
- 审批历史与审计（现有 agent 审计日志不存消息正文，也不应存审批内容）。
