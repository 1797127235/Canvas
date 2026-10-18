# 问题：视频网关兼容层与 Codex2API 协议不一致

状态：只记录问题与证据，未改代码。2026-10-16 在本机 `localhost:3000`（运行目录 `/home/liu/桌面/infinite-canvas-main`，API 日志 `/tmp/canvas-api.log`）实测。代码以本仓库 `server/src/ai/gateway-video.ts` 为准，与运行目录该文件一致。

## 现象

画布 `7a9gaAO8p15SJf0tQ8Gwt` 用同一张参考图、同一句提示词「图中生物跳舞视频」生成视频：

- `grok-imagine-video-1.5` 图生视频成功。
- `MiniMax-H3` 两次都被上游拒绝，页面只显示「生成失败，请稍后重试」。
- `seedance-2.5` 任务成功并出片，但成片不是参考图里的内容，等于只做了文生视频。

## 根因

`server/src/ai/gateway-video.ts` 把 Codex2API 的 `POST {baseUrl}/videos` 写成一套统一 JSON：`duration`、`resolution`、`aspect_ratio`、`reference_images`、`image`、`last_frame`、`videos`、`audios`。注释称这是「JSON 兼容协议，不是 OpenAI 原生 multipart 或 MiniMax /v2」。

站点文档不是这样分的。`/v1/videos` 是 OpenAI Videos 入口，字段是 `seconds`、`size`、单张 `input_reference.image_url`。`duration`、`resolution`、`ratio`、`images` 被标成旧中继字段，默认原样转发，不按模型名转换。`reference_images` 是 Grok `/v1/videos/generations` 的字段，不在这个入口里。

模型发现把名字不是 `grok-imagine` 的视频一律标成 `gateway-videos`（`server/src/catalog/catalog.ts` 的 `adapterForModel`）。Seedance 和 H3 都进了这套旧字段。

## 站点实际协议

出处是 2026-10-16 抓取的 `https://www.codex2api.com/assets/ApiDocsView-DqWmz9JI.js`（页面 `https://www.codex2api.com/docs/video-compat-create`、`https://www.codex2api.com/models` 是前端渲染，正文在该脚本内）。

| 协议 | 创建 | 本仓库 |
| --- | --- | --- |
| Grok | `POST /v1/videos/generations`，`reference_images`、`aspect_ratio` | 已接，`xai-videos` |
| OpenAI Videos | `POST /v1/videos`，`seconds`、`size`、单张 `input_reference.image_url` | 未接。当前网关发的是旧字段 |
| 兼容视频 | `POST /v1/video/generations`（无 s），参数继续跟供应商 | 未接 |
| Seedance / 方舟 | `POST /api/v3/contents/generations/tasks`，`content` 数组、`ratio` | 未接 |
| MiniMax 原生 | `POST /v2/video_generation` | 未接 |
| Kling、万相 | 各自原生路径 | 未接 |

OpenAI Videos 的补充约定：

- 账号必须勾选该入口，且模型被允许使用。未启用时入口不可用，不会退回其他端点。
- 参考图只有一张。H3 走管理员显式选择的「秘塔 H3」适配，只认 768p 和 2K，不按模型名自动启用。
- 完成态是 `completed`，下载是 `GET /v1/videos/{id}/content`。这两点和当前轮询一致，所以错误字段的请求仍可能「成功出片」。

## 实测

同一用户、同一参考图 `remote:16e50214-1f9b-48fb-b5f0-07178e5a9b04`。

| 时间 | 模型 | 发出的关键字段 | 结果 |
| --- | --- | --- | --- |
| 15:28:45 | MiniMax-H3 | `resolution: 720p`，无 `size` | 400 `Metaso H3 resolution must be 768p or 2k` |
| 15:32:34 | seedance-2.5 | `resolution: 480p`、`aspect_ratio`、`reference_images`，无 `seconds`/`size`/`input_reference` | 201，15:36:43 完成，mp4 1,686,575 字节，参考图未被采用 |
| 15:34:42 | MiniMax-H3 | `resolution: 768p`、`aspect_ratio: 1:1`，无 `size` | 400 `Metaso H3 requires both resolution and ratio, or an explicit size` |
| 15:29:06 | grok-imagine-video-1.5 | Grok 自己的 `/v1/videos/generations` | 成功，720×720，1,450,036 字节 |

页面上的 502 文案是「生成失败，请稍后重试」。上游原文只在 `scope=generation` 日志里。

## 需要改的范围

只改 `gateway-video.ts` 组给 `/v1/videos` 的请求：

- 时长发 `seconds`，尺寸发 `size`（如 `480x480`）。
- 一张参考图发 `input_reference.image_url`。
- 去掉 `duration`、`resolution`、`aspect_ratio`、`reference_images`、`image`、`last_frame`、`videos`、`audios`。
- 多张图、参考视频、参考音频这个入口没有字段，直接报错，不能再静默丢弃。

Grok 的 `xai-videos` 不动。MiniMax `/v2` 和方舟 `content` 数组不在这一层里，本次不顺手加。

## 过时记录

`docs/specs/generation-media-payload-investigation.md` 第四节把上游形状写成 `reference_images: [{url}]`，那是当前代码的行为，不是 Codex2API OpenAI Videos 的契约。以本文为准。
