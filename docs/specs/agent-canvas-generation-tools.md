# 规格：画布助手的生成工具

状态：设计阶段，未实现。属于 [agent-copilotkit.md](./agent-copilotkit.md) 第十节第 1 项的落地拆解。

## 目标与范围

助手目前只能改画布结构（`apply_graph` / `update_node` / `delete_nodes` / `connect_nodes`），无法产出内容。本轮让助手能直接生成图片和视频，用户说「按这个提示词出三张图」时，助手自己完成，不用再手动点按钮。

本轮范围：

- 新增 `generate_image`、`generate_video` 两个前端工具。
- 复用既有生成链路（`handleGenerateNode` → `/api/generations`），不新增服务端接口、不改 gateway。
- 生成参数沿用画布现有的「节点配置 > 全局配置 > 默认值」优先级链，助手只补充节点上还没设的部分。

不做：音频与文本生成工具、生成结果主动回灌、能力目录、尺寸/时长枚举、成本统计。

## 现状与问题

唯一生成入口是 `web/src/pages/canvas/project.tsx` 的 `handleGenerateNode(nodeId, mode, prompt)`（约 2324 行起，四百多行）。直接把它包成工具会踩五个问题：

1. **返回 `Promise<void>`**，没有任何结果，模型无法知道成功还是失败。
2. **存在静默早退**：`!isAiConfigReady(...)` 时调 `openConfigDialog(true)` 后 `return`；`generationOutputNode` 抛错时 `message.error` 后 `return`。包成工具后模型会收到「成功」，画布上却什么都没发生。
3. **会 await 整条链路**：图片走 `mapWithConcurrency` 等每张图落盘，视频走 `completeVideoNodeTask` 等上游任务结束。视频几分钟，工具调用等不起。
4. **输出节点 id 是运行时才定的**：源节点是 text/config 时会新建子节点（`rootId = nanoid()`），返回值里拿不到。
5. **CopilotKit 不校验工具入参**。已核实 `@copilotkit/core` 的 `parseToolArguments` 只做 `JSON.parse` + `ensureObjectArgs`，`parameters` 里的 zod schema 仅被转成 JSON Schema 发给模型。花用户钱的工具必须自己在 handler 里 `parse`。

## 配置来源：接入既有优先级链

`buildGenerationConfig`（`web/src/lib/canvas/canvas-generation-helpers.ts:84`）已经是：

```text
节点 metadata  >  全局 effectiveConfig  >  defaultConfig
```

助手的选择放进这条链，位置在**节点 metadata 之下、全局配置之上**：

```text
节点 metadata（用户手调的，最高）
  > 助手本轮显式参数
    > 全局 effectiveConfig
      > defaultConfig
```

- 节点上用户已经设过的 `model` / `size` / `seconds` 不得被助手覆盖。
- 全局配置只是兜底，用户说「要竖版」时助手应当能压过它。

**实施方式**：给 `handleGenerateNode` 增加可选第 4 参数 `overrides?: Partial<AiConfig>`，在 `buildGenerationConfig` 之后合并一行：

```ts
const generationConfig = { ...buildGenerationConfig(effectiveConfig, sourceNode, mode), ...overrides };
```

这行放在 `isAiConfigReady` 检查之前，让预检也使用覆盖后的模型。现有三处调用点不传该参数，行为不变。

不采用「先 `setNodes` 写节点 metadata 再调 `handleGenerateNode`」：`nodesRef.current` 要等下一次 render 后的 effect 才更新（`project.tsx:598`），紧接着调用会读到旧节点，覆盖参数丢失。

## 工具契约

两个工具都只接受「助手能可靠判断」的参数。模型、尺寸这类需要上游能力约束的，本轮先不开。

### `generate_image`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `nodeId` | string | 是 | 源节点：空 image 节点，或 text / config 节点 |
| `prompt` | string 1..4000 | 是 | 生成提示词 |
| `count` | int 1..4 | 否 | 不传则用配置里的张数 |
| `model` | string | 否 | 必须在账号模型目录里且 `capability === "image"` |

### `generate_video`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `nodeId` | string | 是 | 源节点：空 video 节点，或 text / config 节点 |
| `prompt` | string 1..4000 | 是 | 生成提示词 |
| `model` | string | 否 | 必须在账号模型目录里且 `capability === "video"` |

不给 `size` / `quality` / `seconds` / `vquality` / `background`：这些值的合法范围目前只写在 provider 实现里，`/api/models` 不返回。开放给模型等于让它编字符串，第一跑就报错。等能力目录（第十节第 2 项）落地后再逐个开放为 `z.enum`。

`nodeId` 必填而不是「不传就自己建」：助手先用 `apply_graph` 建节点再生成，`nodeId` 稳定，结果落在用户看得见的位置，也便于下一轮用 `get_node_detail` 查状态。工具内部不做布局。

## 异步执行

工具立即返回，不等生成结束：

```ts
{ status: "started", sourceNodeId, note: "生成在后台进行，结果节点稍后出现在源节点下游" }
{ status: "rejected", reason: "账号还没有可用的图片模型，请先在设置里完成配置" }
{ status: "cancelled" }
```

`handleGenerateNode` 自身会把任务号写进节点（图片 `slotTaskIds`，视频 `preTaskId`），刷新可恢复，不需要工具额外记录。

### 预检必须与内部判断一致

工具返回 `started` 之后画布没有任何变化，是这一层最严重的失败模式。因此预检不能只写一半，要和 `handleGenerateNode` 内部的前置判断完全对齐，并抽成纯函数供两边共用：

```ts
// web/src/lib/canvas/canvas-agent-generation.ts
export function checkGenerationTarget(input: {...}): { ok: true; config: AiConfig } | { ok: false; reason: string }
```

检查项：

1. 节点存在。
2. 节点类型与 mode 匹配（image 工具只接受 image / text / config；video 同理）。
3. 覆盖的 `model` 在 `useCatalogStore.models` 里且能力匹配。
4. `isAiConfigReady(config, config.model)`。
5. `prompt.trim()` 非空（video / image 都要求）。
6. `generationOutputNode` 不抛错（模板配置节点的输出节点可能已被删）。

`handleGenerateNode` 改为调用同一个函数，把 `{ ok: false }` 转成它现有的 UI 反馈（`openConfigDialog` / `message.error`）。这样两处不会漂移。

## 确认闸门

视频必确认，图片按张数确认（`count > 2` 时确认）。生成花的是用户自己的钱，不能由模型单方面决定。

**不使用 `useHumanInTheLoop`**：本面板是自绘消息列表（`MessageRow` + `toolLabel`），不经过 `CopilotChat` 的渲染层，`useHumanInTheLoop` 的 `render` 不会被调用。要接就得先把面板改成 CopilotKit 组件，代价远大于收益。

改用 `project.tsx` 已有的 `modal.confirm`（`App.useApp()`）。工具 handler 内 `await` 一个 Promise，用户确认才调 `handleGenerateNode`，取消返回 `{ status: "cancelled" }`（不是错误，模型可以继续问）。

时序上安全：工具在服务端没有 `execute`，模型发出工具调用后本轮流已结束，前端执行 handler 期间不在 run 中，弹窗不会卡住 SSE。

## 结果回灌（本轮不做）

生成完成后，模型不会自动知道结果。当前可行的路径是用户下一轮再问，模型用 `get_node_detail` 查 `status` / `errorDetails` / `images`。本轮把这一点写进系统提示词，并留 seam：`project.tsx` 里图片和视频的完成分支都已经在 `setNodes`，后续在那里通知 launcher 注入一条消息即可。

## 与 `apply_graph` 的配合

推荐的助手流程：

```text
1. apply_graph   建一个 text 节点（写提示词）+ 一个空 image 节点 + 一条连线
2. generate_image 传空 image 节点的 id 和提示词
3. 告诉用户「已开始生成，完成后告诉我，我可以帮你看结果」
```

源节点为空 image / 空 video 节点时，`handleGenerateNode` 会原地填充（`isEmptyImageNode` / `isEmptyVideoNode`），不会新建子节点，`nodeId` 全程稳定。这是应当引导助手走的主路径。

## 系统提示词改动

`server/src/agent/run.ts` 的 `INSTRUCTIONS` 增加：

- 生成是异步的：工具返回 `started` 只代表已开始，不得说「已生成」「已经画好了」。
- 生成前先把提示词写清楚；一次最多 4 张图，视频默认一条。
- 视频和音频会花钱且慢，执行前先说明要做什么，由用户确认。
- `rejected` 要把 `reason` 原样告诉用户，不要自己猜原因。
- 需要看生成结果时用 `get_node_detail` 查状态。

## 顺带修复

`web/src/components/canvas/tools/use-canvas-tools.ts` 里 5 个工具的 handler 都没有 `parse` 入参，直接按 TS 类型信任参数。由于 CopilotKit 不校验（见上文问题 5），`updateCanvasNodeInput` 的 `refine`（至少给一个字段）实际从未执行。本轮把 5 个 handler 一并改成先 `parse`，失败返回可读原因，和 `use-apply-graph-tool.ts` 的写法对齐。

## 不做

- 音频、文本生成工具。
- 尺寸 / 时长 / 质量 / 背景等参数开放（阻塞于能力目录）。
- 生成结果主动注入对话。
- 成本预估与额度控制。
- 批量生成多个视频、视频续写、参考视频/音频传入。

## 测试计划

纯函数层（`web/tests/`，无需浏览器）：

- `checkGenerationTarget`：节点不存在 / 类型不匹配 / model 不在目录 / model 能力不符 / 未配置 / prompt 为空 / 模板输出节点缺失，各返回对应 reason；正常路径返回合并后的 config。
- 覆盖优先级：节点已有 `model` 时不被 `overrides` 覆盖；节点没有时 `overrides` 生效。
- 入参 schema：`count` 越界、`prompt` 超长、未知字段被拒。

人工验收（登录浏览器 + 真实账号）：

- 「在画布上加一个文本节点写夕阳，然后生成一张图」：节点出现、开始生成、图片落到空 image 节点、刷新后仍在、Ctrl+Z 可撤销。
- 视频生成弹确认，取消后画布无变化且助手没有说「已生成」。
- 未配置模型时助手给出中文原因，不打开配置弹窗。
- 生成过程中再问助手，助手回答「还在生成」。

## 分阶段实施

| 阶段 | 内容 |
| --- | --- |
| 1 | `checkGenerationTarget` 纯函数 + 单测；`handleGenerateNode` 接入该函数（行为不变） |
| 2 | `handleGenerateNode` 增加 `overrides` 参数（一行合并） |
| 3 | 新增 `startAgentGeneration` 回调，串预检 → 确认 → 不 await 地启动。它需要 `handleGenerateNode` 与 `modal`，所以放 `project.tsx`（与 `use-canvas-agent-actions.ts` 的分工：那个文件只放纯粹的画布 state 写入，不碰生成与确认弹窗） |
| 4 | `tools/use-canvas-generation-tools.ts` 注册两个工具；launcher 传入新回调 |
| 5 | 系统提示词更新；`use-canvas-tools.ts` 补 `parse` |
| 6 | 文档：`agent-copilotkit.md` 第八/十节、`pending-test.mdx`、`CHANGELOG.md` |
