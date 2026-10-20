# 规格：画布助手的图片附件

状态：已实现（v1 仅图片）。服务端 6 项专项测试、前端 4 项专项测试、两端类型检查通过；登录浏览器验收见 `docs/content/docs/progress/pending-test.mdx`。

## 目标与范围

助手输入框的 `+` 此前是「新建会话」，与顶栏会话下拉里的「新对话」重复。本轮把它改成上传附件：用户可以直接把参考图拖进对话，让助手看图、讨论，并把图片作为画布素材使用。

范围：

- 图片附件上传（`image/*`），单条消息最多 4 张，单张不超过 8 MB。
- 消息里只保存资源身份 `remote:<uuid>`，字节留在账号媒体库。
- 服务端把最近 4 张附件解析成图片内容交给模型。
- 附件身份写进消息文本，助手可以用它作为 `apply_graph` 的 `storageKey`。
- 用户消息气泡展示附件缩略图。

不做：

- 视频、音频、文档附件（模型目前只接收图片；上传后也无法理解内容）。
- 拖拽、粘贴上传。
- 自动加入资产库。
- 让模型直接“看到”画布上已有的图片（另属多模态能力，见 `agent-copilotkit.md` 第十节）。
- 附件删除接口；未引用的媒体由每日回收在 7 天后清理。

## 消息契约

有附件时 `content` 从字符串变成 `ContentPart[]`：

```ts
{
  id, role: "user",
  content: [
    { type: "text", text: draft },
    { type: "image", id: "remote:xxx",
      source: { type: "url", value: "remote:xxx", mimeType: "image/png" } },
  ],
  metadata: { attachments: [{ storageKey: "remote:xxx", name, mimeType, bytes }] },
}
```

没有附件时保持字符串，历史消息、标题提取和压缩逻辑不需要区分数组形态。

`metadata.attachments` 只给前端渲染缩略图；`source.value` 是服务端读取字节的唯一依据。`remote:` 是资源身份，不是可请求的 URL。

选择这个形状的原因：会话表有 400 条 / 2 MiB 上限，base64 写进消息几次就会爆；`server/src/media.ts` 的回收 SQL 已经扫描 `user_agent_threads.messages` 里的 `remote:<id>`，存身份天然不会被回收；`readAccountMediaBytes` 自带 `user_id` 校验，伪造别人的 id 读不到。

## 服务端解析

`server/src/agent/attachments.ts` 的 `inlineRemoteImages` 在 `prepareAgentContext` 之后、`toModelMessages` 之前执行：

1. 找出所有 `source.type === "url"` 且以 `remote:` 开头的图片 part。
2. 只解析文档顺序最后 4 个（最近的附件）。
3. 按账号读字节，转成 `source.type === "data"`。
4. 单张超过 8 MB、类型不是图片、读取失败或超过单轮 16 MB 总预算时，只保留身份、不送字节。
5. 每条带附件的用户消息追加一行文本：`用户上传的附件：remote:xxx`。

模型看不到 part id，所以第 5 步是把身份交给模型的唯一方式；系统提示词明确它可以直接作为 `apply_graph` 的 `storageKey`。

不做「全量历史图片每轮重发」：那会让请求体和上游费用随对话线性增长。老附件仍保留身份，模型需要时可以引用，但看不到像素。

`toModelMessages` 遇到残留的 `remote:` URL 直接跳过，避免把非法协议交给 AI SDK。

## 前端

- `web/src/lib/agent/attachments.ts`：校验、消息组装、metadata 读取，纯函数可单测。
- `canvas-agent-launcher.tsx`：`+` 打开文件选择；选中即上传（`uploadMediaFile(file, "agent")`），缩略图用 `previewUrlFor(storageKey)`；上传中显示 spinner 并禁止发送；附件可单独移除。
- 发送按钮在有附件、无文字时也可用。
- 用户气泡按 `metadata.attachments` 渲染缩略图，不重新解析 content。
- 本地豁免模式下 `uploadMediaFile` 产出的是 `image:<id>`，服务端读不到；此时提示需要登录，不放入附件列表。

## 限制与边界

| 项 | 值 | 原因 |
| --- | --- | --- |
| 单条消息附件数 | 4 | 与单轮内联上限一致，控制上下文与费用 |
| 单张大小 | 8 MB | nginx `/api/` 请求体上限 |
| 单轮内联总量 | 16 MB | 4 张满额图约 21 MB base64，避免请求体失控 |
| 附件类型 | `image/*` | 服务端只把图片传给模型 |

## 测试计划

纯函数（已通过）：

- 类型、大小、数量校验各返回对应原因。
- 无附件保持字符串；有附件生成 text + image parts。
- metadata 往返，畸形条目被过滤。
- 服务端只内联最近 4 张、仍保留全部身份。
- 读取失败或无 reader 时丢弃图片、保留身份。
- 非 `remote:` 图片与纯文本消息不被改动。

人工验收：

- 点 `+` 选择一张图片，出现缩略图，可移除。
- 只发图片不打字也能发送；助手能描述图片内容。
- 上传后刷新页面，消息里的缩略图仍在。
- 说「把这张图放到画布上」，助手用 `remote:` 身份建出图片节点。
- 上传非图片、超过 8 MB、第 5 张时给出中文提示且不进入列表。
- 上传中发送按钮不可用；上传失败有提示。

## 后续

- 视频/音频附件：需要上游与协议都支持对应模态后再开放。
- 画布图片进入对话：把节点素材也转换成同样的 image part，属多模态能力。
- 附件生命周期：目前依赖 7 天宽限回收，尚无主动删除入口。
