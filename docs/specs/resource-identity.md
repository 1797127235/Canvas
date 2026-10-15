# Spec: 资源身份单点化

状态：**已实现**（用户已确认方案与边界值）。实际落地四步：上行改身份、下行返回身份、引用表与回收、请求体分档上限；未做「引入 `Resource` 类型/资源注册表」这一抽象（有意不做，见第九节）。
属 [capability-map.md](./capability-map.md) 的 `media`、`generation`、`workspace` 边界。
根因来自 [media-data-flow-audit.md](./media-data-flow-audit.md) 第 1.2 / 1.3 / 1.6 节。前身审计见 [generation-media-payload.md](./generation-media-payload.md)。

## 一、要解决的问题

服务端已经是字节的唯一权威（`user_media` 表 + 磁盘或 MinIO），**但接口契约和客户端仍然假设「字节在浏览器手里」**。同一个资源因此在网络上来回搬运、在磁盘上存成多份。

一张账号模式生成图片的完整旅程（当前代码）：

| 步骤 | 位置 | 发生的事 |
| --- | --- | --- |
| 1 | `server/src/generation.ts` `runImageTask` | 上游结果写入 `user_media` → **id=A** |
| 2 | `web/src/services/api/image.ts` `readAccountMediaDataUrl` | 前端 `fetch('/api/media/A')` 读回，**转成 base64** |
| 3 | 同文件 `pollServerImageTask` | 包成 `{ id: nanoid(), dataUrl }` |
| 4 | `web/src/pages/canvas/project.tsx` `uploadImage(result.images[0].dataUrl)` | 再 `POST /api/media` 传回服务端 → **id=B** |

同一张图过 3 次网络、磁盘存 2 份，id=A 成为无人引用也无人删除的孤儿。视频多一步：`downloadGatewayVideo` 用 `Buffer.from(await response.arrayBuffer())` 把整个视频读进 api 进程内存，流给浏览器后前端 `storeGeneratedVideo` 又把它传回服务端。

参考素材方向同样：`server/src/ai/input.ts` 的 `imageData` / `videoData` / `audioData` **本身就要求 data URL**，所以每次生成都要把全部素材 base64 内联重传一次（线上实测一次三素材视频建任务请求体 29.5MB）。

**这不是某处实现写歪了，是契约层面的形状。** 只改实现不改契约，会在下一个入口再抄一遍。

## 二、目标与不变量

目标：**一个资源只有一处权威、只有一个身份；浏览器只持有身份，不再持有字节。**

必须保持不变：

- 本地模式（`VITE_AUTH_BYPASS=true`）的行为和存储完全不动。该模式不经过 `/api/generations`，只在 `web/src/services/api/*` 内部走直连分支，本方案不动那些分支。
- 参考图的 512KB / 合计 700KB 压缩（`normalizeVideoImages`）行为不变，只换输入字节的来源。
- `user_media` 的按账号隔离与既有 `object_key` 布局不变。
- `remote:<uuid>` 前缀本身不变，仍是客户端持有的资源身份。

## 三、契约：`remote:<uuid>` 是线上的唯一素材格式

```ts
const mediaRef = z.string().regex(/^remote:[0-9a-f-]{36}$/);
```

账号模式下所有参考素材在进入生成请求前**必然已经上传**（`uploadImage` / `uploadMediaFile` 在 `!bypassLocalAuth` 时都走 `uploadAccountMedia`，返回 `storageKey = remote:<id>`），所以 `imageData` 那三条 data URL 正则可以直接删掉，不需要任何兼容分支。

## 四、上行：入参从字节改成身份

### 4.1 客户端

`web/src/services/api/image.ts` `requestAccountImages`、`web/src/services/api/video.ts` `createVideoGenerationTask` 账号分支：

- 不再调用 `imageToDataUrl`、`referenceMediaToFile`、`readFileAsDataUrl`。
- 直接收集 `references.map((image) => image.storageKey)`，`videos` / `audios` 同理。
- 缺少 `remote:` 身份的素材直接抛错（账号模式不该出现本地素材）；不做静默兜底。

`image_refs` 字段删除：它可由 `images` 完整推导，且 `createVideo` 从未读取它（当前只写进日志）。

### 4.2 服务端

`server/src/media.ts` 抽出唯一的读字节入口：

```ts
export async function readAccountMediaBytes(database: Pool, options: MediaOptions, userId: string, mediaId: string): Promise<{ bytes: Buffer; mimeType: string }>
```

按 `id + user_id` 查 `user_media`，从存储读回。查不到即 404 语义（跨账号或不存在，不区分）。

`server/src/ai/generation.ts` 增加解析器，把 `mediaRef` 换成 AI SDK 的素材：

```ts
type MediaReader = (mediaId: string) => Promise<{ bytes: Buffer; mimeType: string }>;
```

- `createImages`：`images` 解析成 SDK 接受的素材形态。`@ai-sdk/provider` 的 `DataContent = Uint8Array | string | URL`，**直接传 `Uint8Array`，服务端不再自己拼 base64**。
- `createVideo`：`normalizeVideoImages` 改为接收 `{ bytes, mediaType }`，压缩逻辑（512KB / 700KB、`VIDEO_IMAGE_STEPS`）原样保留，输出改为 `{ data: Uint8Array, mediaType }`。frameImages / inputReferences 的组装不变。

上游协议本身是 JSON + base64，base64 编码无法避免——但**它现在只发生在服务端编码的那一刻，不再经过浏览器**。

## 五、下行：结果只返回身份

### 5.1 图片

`user_generation_tasks.result` 已经是 `{ mediaIds: string[] }`。

- 客户端 `pollServerImageTask` 直接返回 `{ mediaId }`，删除 `readAccountMediaDataUrl`。
- 画布与工作台用它构造 `{ storageKey: 'remote:' + mediaId, url: '/api/media/' + mediaId }`，**不再 `uploadImage`**。
- `naturalWidth` / `naturalHeight` / `bytes` / `mimeType`：不再由客户端「读回再解码」取得（那会解码 4K 原图，正是上一轮要消灭的开销）。由服务端在 `storeAccountMedia` 落库时一并返回：`sharp.metadata()` **只读文件头、不解码整图**，宽高与 `bytes` / `mimeType` 一起写进 `result`，客户端直接使用。图片任务同时把这两个值写入 `user_generation_tasks.result`。

id=A 不再成为孤儿，磁盘副本数 2 → 1。

### 5.2 视频

- `downloadGatewayVideo` 改为**流式**：返回 `Readable` 而不是 `Buffer`，直接 `pipeline` 进 `store`，不再整块进 api 进程内存。`storeAccountMedia` 增加流式变体（用 `Transform` 计数得 `byte_size`）。
- `readTask` 在 `status === completed` 时把视频落进 `user_media`，把 `result = { mediaId }` 写回任务行；后续轮询直接返回已存的 `mediaId`，不重复下载。用进程内 `Set` 加锁，避免并发轮询重复落盘（与 `imageTasks` 同一套写法）。
- 删除 `GET /generations/:id/content`；客户端 `fetchServerGenerationContent` 一并删除。
- `pollVideoGenerationTask` 的 completed 分支改为拿 `mediaId`，`storeGeneratedVideo` 不再需要「把 blob 传回服务端」这一步。

### 5.3 音频

`createSpeech` 当前把字节直接当响应体返回，客户端再 `storeGeneratedAudio` 传回。改为服务端落 `user_media`，返回 JSON `{ mediaId }`。`web/src/services/api/audio.ts` 账号分支相应改为读 JSON。

### 5.4 顺带

`user_generation_tasks.operation` 对图片任务写的是 `JSON.stringify(input)`（含内联 base64）。入参改为 id 后这一列自然缩小到 1KB 级，**不需要额外改动**。视频任务的同列本来就只存 operation 号。

## 六、回收：从「查不出来」改成一次 anti-join

新增迁移 `server/sql/008-media-references.sql`：

```sql
CREATE TABLE IF NOT EXISTS user_media_references (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id UUID NOT NULL,
    workspace_version BIGINT NOT NULL,
    PRIMARY KEY (user_id, media_id)
);
```

- `putWorkspace`（`server/src/workspace.ts`）在写工作区的**同一个 pass** 里扫描 `projects` / `assets` 里全部 `remote:<uuid>` 字符串，用新版本号 upsert 进引用表。不改客户端，不改工作区数据形状。
- 未被任何现有引用覆盖、且创建时间超过宽限期的媒体，即为可回收：一条 anti-join 即可选出。
- 前端补 `DELETE /api/media/<id>` 的封装与调用点（删画布、删节点、删素材、删历史时）。

**这一节是四节里唯一有数据删除风险的部分**，宽限期与执行周期在第八节单列确认。

## 七、请求体上限

契约改成 id 之后，`POST /api/generations` 的请求体从 29.5MB 降到 1KB 级，收紧才有意义（顺序反了会直接打死正常功能）。

- `server/src/app.ts` 的 `express.json({ limit: Infinity })` 改为显式上限。
- `nginx.conf` 的 `client_max_body_size 0` 改为对 `/api/` 设上限，`/api/media` 保留不限制。
- `rejectLargeIdentityBody` 的 4096 字节身份限制保持不变。

## 八、边界值（按 AGENTS.md，动手前需确认）

| # | 项 | 采用值 | 影响与失败表现 |
| --- | --- | --- | --- |
| 1 | `/api/generations`、`/api/generation-tasks` 请求体上限 | **1 MiB** | 超限返回 413（已有测试覆盖）。改契约后正常请求约 1KB |
| 2 | 其余业务 JSON（含 `/api/workspace`）上限 | **8 MiB** | 工作区含全部画布与助手会话；账号模式下素材字段已为空（`storageKey` 存在时 `dataUrl` 置空），故取 8 MiB 余量。本机无数据库未实测，待真实画布确认 |
| 3 | nginx `/api/` | **8m**（`/api/media` 0） | nginx 取各档最大值即可，细粒度由 api 分路径把关；否则会挡住工作区保存 |
| 4 | 单个媒体上传大小上限 | **不设** | 按 AGENTS.md 开发阶段不设额度 |
| 5 | 无引用媒体的回收宽限期 | **7 天** | 短于 7 天会让「删了再撤销」丢数据 |
| 6 | 回收任务执行周期 | **每日一次**（启动时先跑一遍） | 失败表现是磁盘不释放（不删胜过误删） |

## 八·补、回收的防误删设计

引用表是后来才加的，旧数据首次上线时它是空的——只看引用表会把还在用的媒体删光。因此回收同时满足四个条件才删：① 创建超过宽限期；② 引用表无记录；③ 工作区原文里搜不到 `remote:<id>`；④ 生成历史原文里搜不到 `remote:<id>`。任一条不满足即保留。

## 九、明确不做

- 不引入新的抽象层（不做 `Resource` 类型 / 资源注册表）；只收敛身份与字节的归属，保持现有函数形状。
- 不合并前端 6 个 localforage 容器。
- 不改本地模式（`bypassLocalAuth`）的任何行为与数据。
- 不写旧数据迁移与兼容分支（项目未上线）。
- 不动上一轮已完成的三层内存修复（预览分档、批量展开封顶、生成并发上限）。

## 十、验证

- 服务端 `bun run typecheck` + `bun run test`（本机基线 55 通过 / 7 环境失败）。
- 前端 `bun run typecheck` + `bun test`（当前基线 39 通过）。
- `server/tests/request-logging.test.ts` 里 `image_refs` 相关断言随字段删除一并更新。
- `server/tests/account-media.test.ts` 增加：跨账号 `remote:` 引用被拒绝；预览分档断言保持。
- 新增服务端测试：入参为 `remote:` id 时能从 `user_media` 取到字节；图片任务落库后**同一 id** 被客户端直接使用（不再产生第二个 id）。
- 手工验收：真实账号跑一次三素材视频生成，确认请求体从 MB 级降到 KB 级、上游正常收单；跑一次图片生成，确认画布节点引用的是同一个 id、`user_media` 只多一行。

## 十一、落地顺序

分五步，每步独立可验证、可停：

1. **上行改 id**：`ai/input.ts` + `media.ts` 读字节 + 两条账号客户端的素材收集。（收益：单次请求体 MB → KB）
2. **图片下行返回 id**：删 `readAccountMediaDataUrl`，客户端直接用 `remote:` 构造。（收益：磁盘 2 份 → 1 份，孤儿消失）
3. **视频 / 音频下行落库**：流式落盘、删 `/generations/:id/content`、音频改 JSON。（收益：api 进程内存不再整块持有视频）
4. **引用表与回收**：迁移 + `putWorkspace` 扫描 + 前端删除入口。（收益：磁盘不再单调增长）
5. **收紧请求体上限**：`app.ts` + `nginx.conf`。（收益：消除唯一的远程可利用项）

第 1 步是收益最大、风险最低的一步，可以先只做它并观察线上表现。
