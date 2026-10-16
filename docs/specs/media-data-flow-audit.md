# Spec: 服务端与网页端数据流向审计

状态：只做代码审计，未改动任何代码。属 [capability-map.md](./capability-map.md) 的 `media`、`workspace`、`generation` 边界。

审计范围：当前分支 `feat/server-media-references` 的服务端全部源码（`server/src`，1728 行）和前端数据层（`web/src/services`、`web/src/stores`、画布生成与导出链路，约 4000 行）。只看**资源与数据流向**层面的系统性问题，不含代码风格。

已单独成文的「生成请求内联素材」[generation-media-payload.md](./generation-media-payload.md) 是本文第二节的一个实例。

## 一、根因：项目没有「资源」这个类型

全仓库搜索 `Resource` / `resourceStore` / `mediaRegistry` 一律为空：**没有统一的资源类型、资源表或资源注册表**。

资源只是一段字节加一个字符串键，散落在各处，各自约定。由此产生下面五类后果，第二节起逐条展开。

### 1.1 资源的「身份」是一个字符串前缀

`remote:` / `image:` / `video:` / `audio:` / `file:`，靠 `startsWith` 解码。同一个前缀判断被反复重写：

- `remote:`：`web/src/services/api/media.ts`（2 处）、`image-storage.ts`（4 处）、`file-storage.ts`、`canvas-generation-helpers.ts` 等 8 处以上。
- `image:`：`canvas-export.ts`（2 处）、`templates.ts`（2 处）、`media-package.ts`、`image-storage.ts` 等 6 处以上。

没有一处定义「这些前缀是什么、谁产生、谁消费」。

### 1.2 同一资源同时挂着三个名字，且含义随模式漂移

`storageKey` + `url`/`content` + `dataUrl` 三者并存于同一对象（`web/src/types/image.ts` 的 `ReferenceImage`、`CanvasNodeMetadata`）：

| 字段 | 账号模式 | 本地模式 |
| --- | --- | --- |
| `storageKey` | `remote:<uuid>` | `image:<nanoid>` |
| `content` / `url` | `/api/media/<uuid>`（持久） | `blob:<uuid>`（**刷新即失效**，靠 `hydrateCanvasImages` 抢救） |
| `dataUrl` | 按需现算 base64 | 直接存 base64 |

`ReferenceImage.id` 更是三套身份空间：画布上是 `node.id`（`canvas-generation-helpers.ts`），工作台是 `nanoid()`（`api/image.ts`），Agent 引用是 `canvas:<id>`（`canvas-resource-references.ts`）。

### 1.3 结论

不是「存储分散」和「流向混乱」两个问题，而是**一个**：资源没有统一建模，于是身份、存放、流转、生命周期四处各立一套约定。后面所有问题都是这个缺口的必然结果。

## 二、后果一：同一份字节真的存了多份（字节副本）

### 2.1 生成结果被重复落库

图片生成完成后，服务端已经存好，客户端又读回浏览器再上传回同一台服务器：

```text
上游 → 服务端 → storeAccountMedia 落 user_media(id=A) → 磁盘
  → 客户端 GET /api/media/A 读回全部字节 → base64 成 dataUrl
  → uploadImage(dataUrl) → POST /api/media → user_media(id=B) → 磁盘
  → <img src="/api/media/B"> 再下一次
```

- 服务端写：`server/src/generation.ts` 的 `runImageTask`。
- 客户端读回：`web/src/services/api/image.ts` 的 `readAccountMediaDataUrl`（分块 `btoa`）。
- 客户端再上传：`web/src/pages/image/index.tsx`、`web/src/pages/canvas/project.tsx`。

结果：同一张图走 **3 次浏览器↔服务端网络**、服务端磁盘存 **2 份**，`id=A` 再无人引用。

### 2.2 视频把字节整块搬两趟

```text
上游 → downloadGatewayVideo 用 Buffer.from(await response.arrayBuffer()) 整块读进 api 进程内存
  → 整块流给浏览器 blob
  → storeGeneratedVideo(blob) → uploadMediaFile → POST /api/media 又传回服务端
```

服务端 `server/src/ai/gateway-video.ts` + `generation.ts` 的 `/generations/:id/content`；客户端 `web/src/services/api/video.ts` 的 `storeGeneratedVideo`。

视频这一跳**连引用都没有**：它没在服务端落 `user_media`，几十 MB 要完整穿过两次进程内存。音频同理（`server/src/generation.ts` 的 audio 分支 `response.send` 回浏览器，前端 `storeGeneratedAudio` 再上传回来）。

### 2.3 任务表把入参 base64 又存一遍

`server/src/generation.ts` 建图片任务时把**整个 `input`** 写进 `user_generation_tasks.operation`：

```js
JSON.stringify(parsed.data.input)   // images: ["data:image/png;base64,..."]
```

而该列对图片任务**只写不读**（`readTask` 只在视频分支解析 `operation`，`GET /generation-tasks/:id` 只读 `kind/status/result/error`）。于是同样的参考图字节，一份在 `user_media`、一份在任务表 `operation`。

对照：视频任务的 `operation` 只存 `{version, adapter, modelId, operation:{id}}`，很干净——同一列、两条链路不一致。

## 三、后果二：同一个资源被记在多个地方（引用副本）

字节没有到处复制，但**引用键被抄了很多份**，且没有哪一份是权威：

| 位置 | 记的是什么 | 代码 |
| --- | --- | --- |
| 画布节点 `metadata` | `storageKey` + `content` | `web/src/types/canvas.ts` 的 `CanvasNodeMetadata` |
| 工作区 JSONB | 上面整份节点（`user_workspaces.data`） | `server/src/workspace.ts` |
| 生成历史 JSONB | `storageKey` 保留、`dataUrl` 置空 | `web/src/pages/image/index.tsx`、`pages/video/index.tsx` 的 `serializeLog` |
| 导出 ZIP | 按 `storageKey` 收集字节 + `projects.json` | `web/src/lib/canvas/canvas-export.ts` 的 `collectStorageKeys` |
| 导入包 | 重建全部引用 | `web/src/services/media-package.ts` |
| 模板克隆 | 重建全部引用 | `web/src/services/api/templates.ts` 的 `rewriteMediaReferences` |

6 个客户端 localforage 容器（`image_files`、`image_previews`、`media_files`、`image_generation_logs`、`video_generation_logs`、`prompt_cache`）加上服务端 4 个位置（`user_media`、`user_workspaces`、`user_generation_history`、`user_generation_tasks`），一张图可以在 6 个以上地方留痕，没有一处能回答「这个资源现在被谁引用」。

## 四、后果三：流转靠前缀猜，且「搬字节」重复实现四遍

没有单一读写入口，每个入口自己实现一遍搬运与重写：

1. 上传：`image-storage.ts` 的 `storeImage`、`file-storage.ts` 的 `uploadMediaFile`。
2. 导入包：`media-package.ts` 递归遍历 JSON，按 `storageKey` 查替换表，再分别改 `content` / `dataUrl` / `url` 三个字段。
3. 模板克隆：`templates.ts` 的 `rewriteMediaReferences` 做同一件事的另一份实现。
4. 导出：`canvas-export.ts` 用 `storageKey.startsWith("image:") ? getImageBlob : getMediaBlob` 猜该用哪个存储。

每新增一个入口（画布、工作台、模板、Agent 引用、导出、导入）就再抄一遍，字段一旦漏改就是静默的坏引用。

## 五、后果四：没有所有者，就没有回收

- 前端没有 `DELETE /api/media/:id` 的封装；`deleteStoredImages` / `deleteStoredMedia` 只操作 IndexedDB。
- `cleanupUnusedImages`（`web/src/services/image-storage.ts`）与 `cleanupUnusedMedia`（`web/src/services/file-storage.ts`）开头都是 `if (!bypassLocalAuth) return;`。
- 服务端 `clearExpiredIdentityData`（`server/src/identity/cleanup.ts`）只清理 `sessions` 和 `identity_rate_limits`。

结果：账号模式下删除画布、删除生成记录、删除素材，服务端 `user_media`、`user_generation_tasks` 和磁盘/对象存储文件都不动。叠加第二节的重复落库，磁盘**双份单调增长**且永无回收。

## 六、后果五：两套模式让上面每一项 ×2

`bypassLocalAuth` 在每个相关函数开头分叉（`storeImage`、`uploadMediaFile`、`generationHistoryStore`、`assetStorage`、`cleanupUnused*`、`media-package`、`templates` …）。两条路径的资源语义完全不同（`blob:` 对 `/api/media/`），却共用同一套字段和同一套函数签名，所以任何资源的读写都要在两种语义下各想一遍。

## 七、其余独立问题

以下与资源建模无关，但同属数据流层面的实际缺陷：

| 问题 | 位置 |
| --- | --- |
| 请求体两层都不设防：`express.json({ limit: Infinity })` 与 nginx `client_max_body_size 0`；`/api/media` 上传也不校验 `content-type`，原样信任并写进 `user_media.mime_type`、后续按它 `response.type()` 回显 | `server/src/app.ts`、`nginx.conf`、`server/src/media.ts` 的 `uploadMedia`/`readMedia` |
| 媒体读取全 `Cache-Control: private, no-store`，前端对 `remote:` 只返回裸 URL（内存缓存只覆盖本地 key），画布上每张图每次进页面都重新全量下载 | `server/src/media.ts`、`web/src/services/api/media.ts` 的 `accountMediaUrl` |
| 工作区整包 JSON 全量重写；409 冲突后 `conflicted` 置位，在 effect 重跑前永久拦住后续保存 | `web/src/components/auth/workspace-sync.tsx` |
| 生成历史无分页，`GET` 一次全读 | `server/src/generation.ts` 的 `/generation-history/:kind` |
| 浏览器仍在拼上游方言（`resolution_name`、`generate_audio`、`watermark`、`mode` 等），服务端再用 AI SDK 翻译一次；上游改字段名前端要跟着改 | `server/src/ai/input.ts`、`server/src/ai/generation.ts` |
| `requestServerImageGeneration` 无任何调用方，死代码 | `web/src/services/api/generation.ts` |

## 八、建议顺序

**先定资源模型，再改链路。** 不先立抽象就逐个打补丁，每修一处都会多一处双形状并存，比现在更难维护。

1. **定义资源模型**（前提）：一个资源一个 id、一处权威位置、单一读写入口、明确归属（`user_id`）与引用关系。先只定义和落地服务端，不改外部契约。
2. **收敛字节副本**（第二节）：生成结果由服务端直接落 `user_media` 并只返回 id，删掉「读回 → base64 → 再上传」；视频改流式落盘；图片任务 `operation` 不再存 input。
3. **收敛引用副本**（第三节）：让画布节点、工作区、历史、导入导出都只引用资源 id，删掉 `content`/`dataUrl`/`url` 的并行字段与各自的搬运实现。
4. **建立生命周期**（第五节）：按引用关系回收无引用媒体与过期任务，前端补删除入口。
5. **入参改素材 id**（已批准的方案 A）加**收紧请求体上限**；上限属会改变实际行为的边界值，需先确认具体数字。
6. 第七节的独立问题按需穿插处理。

第 1 步会改变接口契约与存储布局，需要先确认方案再动手；已知 `docs/specs/generation-media-payload.md` 第四节和本文第三节都指向同一步。

## 九、风险与注意

- 资源模型一旦落地，旧画布里已有的 `data:image/...` 节点内容仍需能渲染。项目未上线，不必写迁移，但新代码不能继续产出多种形状。
- 引入删除路径时必须带 `user_id` 归属校验，并区分「不存在」与「无权限」，不能静默删除。
- 收敛引用副本时，导入包与模板克隆的重写逻辑要一起改，否则会留下两套并行的引用改写。
- 缓存头改动要确认生成结果不会在浏览器里长期滞留；用户上传素材与生成结果可以采用不同策略。
- 收紧 `express.json` 上限前必须确认入参改素材 id 已落地，否则会直接打断现有生成。
