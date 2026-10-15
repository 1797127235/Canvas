# 初步调研：生成请求内联素材

状态：只做了代码考古与现状梳理，未改动任何代码。问题本身见 [generation-media-payload.md](./generation-media-payload.md)。

## 一、当前数据流

同一份素材字节在这条链路上走了两趟：

```text
浏览器 IndexedDB / 已有 remote: 编号
  → 读出字节、base64、塞进 JSON           （web/src/services/api/video.ts）
  → POST /api/generations                （约 29.5MB）
  → 服务端解析、参考图压缩、组装上游载荷    （server/src/ai/generation.ts）
  → POST {baseUrl}/v1/videos，reference_images:[{url:"data:..."}]  （再走一趟 base64）
  → 上游
```

素材在服务端已经有对应的 `user_media` 记录和存储对象，第二趟（浏览器→服务端）是纯冗余。

## 二、代码考古（为什么会长成这样）

| 提交 | 做了什么 |
| --- | --- |
| `783b8a3` | 建立多用户身份和分阶段访问边界；客户端开始出现 `bypassLocalAuth` 双分支 |
| `47ce6f9` | 账号工作区和服务端生成切片；客户端新增 `requestServerGeneration` |
| `5a3a6c8` | 账号生成改由服务端代发。**服务端入参契约在这一版定型** |
| `9a5db4f` | 服务端视频生成改走上游 JSON 协议，data URL 形状原样保留 |
| `7346a2e` | 接入 AI SDK provider 层，服务端内部实现重写，入参契约仍不变 |

关键证据在 `5a3a6c8` 的服务端代码里：

```js
+const imageData = z.string().regex(/^data:image\/(png|jpeg|webp);base64,...$/);
+function appendMedia(form: FormData, field: string, dataUrl: string) {
+    const [header, base64] = dataUrl.split(",");   // 服务端把浏览器发来的 base64 解回来
+    form.append(field, new Blob([Buffer.from(base64, "base64")]), ...);
```

服务端拿到浏览器发来的 data URL 后**解码、再重新编码成 multipart 发给上游**。也就是说：服务端契约是照着「浏览器直连上游」的报文写的，只是把目的地从上游换成了自己。`9a5db4f` 之后上游改走 JSON，这套形状继续沿用至今。

结论：**根因是账号模式把服务端当成透明代理接入，而没有把「素材已经在服务端」这件事反映到契约里。**

## 三、客户端现状

生成入口按 `bypassLocalAuth` 分成两条实现，账号分支连助手函数都和本地分支共用：

- `web/src/services/api/video.ts` 的 `createVideoGenerationTask`
  - 账号分支：第 81 行 `imageToDataUrl` 转参考图、第 82 行 `referenceMediaToFile` + `readFileAsDataUrl` 转参考视频/音频，第 83-88 行连同 `resolution_name`、`generate_audio`、`watermark`、`mode` 一起提交
  - 本地分支：第 89 行起，自己拼上游请求（`createPluginVideoTask` / `createGeminiVideoTask` / `createOpenAIVideoTask`）
- `web/src/services/api/image.ts` 的 `requestAccountImages`：第 776 行同样用 `imageToDataUrl` 转参考图
- `web/src/services/api/generation.ts` 第 9-16 行：`requestServerGeneration` 一次性 `JSON.stringify` 整个 input 提交

**素材其实已经带编号。** 账号模式下画布素材的 `storageKey` 就是 `remote:<user_media.id>`（`web/src/services/api/media.ts` 第 30 行），而存素材时本来就在上传：`web/src/services/image-storage.ts` 第 68 行和 `web/src/services/file-storage.ts` 第 26 行都调用 `uploadAccountMedia`。客户端手里早就有 id，只是没用它。

## 四、服务端现状

- 入参校验死要求 data URL：`server/src/ai/input.ts` 第 3-5 行的三个正则，第 9 行用于 `imageInput.images`，第 15 行用于 `videoInput` 的 `images`/`videos`/`audios`。
- 素材处理在 `server/src/ai/generation.ts` 的 `createVideo`：第 114 行对参考图调用 `normalizeVideoImage`，第 117-121 行把 data URL 拆成 `{data, mediaType}` 的 `inputReferences`。第 156-165 行的 `normalizeVideoImage` 会把超过 512KB 的参考图压成 JPEG。
- 送给上游的形状在 `server/src/ai/gateway-video.ts` 的 `doStart`：参考图/视频/音频分别组装成 `reference_images` / `videos` / `audios`，每项都是 `{url: <data URL>}`。
- 媒体能力已经齐全：`server/src/media.ts` 里 `storeAccountMedia`（服务端落结果）、`uploadMedia`（`POST /api/media`）、`readMedia`（`GET /api/media/:id`，**带 `user_id` 归属校验**），底层是 MinIO 或磁盘目录的同一套抽象，表是 `user_media`。
- **生成记录没有素材引用**：`user_generation_tasks` 的列是 `id, user_id, base_url, model_id, created_at, operation, kind, status, result, error`，其中 `operation` 只存 `{version, adapter, modelId, operation}`（`server/src/ai/generation.ts` 第 135 行）。

## 五、可以直接复用的现成能力

- `POST /api/media` 上传：客户端已有封装 `uploadAccountMedia`（`web/src/services/api/media.ts` 第 25 行），返回 `remote:<id>`。
- 按 id 读取素材：`readMedia` 里那条带 `user_id` 的查询可以直接抽成服务端内部函数。
- 存储抽象：`mediaStore` 同时支持 MinIO 和本地目录，读取路径已经写好。
- 参考图压缩：`normalizeVideoImage` 改成「先取字节再压」即可继续生效，逻辑不用动。

## 六、方案对比

| 方案 | 做法 | 结论 |
| --- | --- | --- |
| A | 请求里传素材编号，服务端按 `user_id` 校验归属后自己取字节 | **建议做**：一次解决延迟、重传、日志和内存问题 |
| B | 在上游载荷里给可访问的 URL，让上游自己拉 | **暂不可行**：`/api/media/:id` 需要会话 Cookie，上游取不到；要么另做带签名的公开地址，范围更大 |
| C | 在 A 的基础上，把生成入参改成自有语义字段，由 adapter 层翻译成上游方言 | 值得做但可后置；现在还有上游字段直接暴露在客户端 |
| D | 在 A 的基础上，把用过的素材编号持久化进任务行 | 溯源的唯一前提，依赖 A |

## 七、建议实施顺序

1. **服务端先定义「素材引用」并支持按编号取字节**（含归属校验）。这一步只增不改，老客户端仍可用 data URL。
2. **客户端改传编号**：已有 `remote:` 的素材直接传编号；本地新选的素材先 `uploadAccountMedia` 再传编号。
3. 覆盖视频参考和生图/改图两条路径。**只改视频会留下两套并存**，比现在更难维护。
4. 视情况再做 C 和 D，先把方向定下来，避免继续在旧方言上加字段。

## 八、待确认项

1. `express.json({ limit: Infinity })` 是否顺手收紧（改完之后请求体本应只有几 KB）。属于会改变实际行为的边界值。
2. 单个素材是否设大小上限（服务端需要把字节读进内存再 base64）。
3. 工作台从本地选素材要多一步「先上传」，确认可接受。
4. 是否同一轮就把生图/改图一起改（建议一起改，理由见第七节第 3 点）。

## 九、风险与验收点

### 风险

- 归属校验必须带 `user_id`，否则可以用别人的媒体编号生成。
- 素材被删或不存在必须明确报错，**不能静默跳过**——静默跳过会让用户拿到一个缺素材的废片。
- 新旧版本兼容：保留 data URL 分支，老前端加新服务端仍可用。
- 服务端读素材失败要区分「没有权限」和「存储读取失败」，提示不能混。

### 验收点

- 用编号提交的生成，上游收到的参考素材与用 data URL 提交时一致（同样的 `reference_images` 形状和内容）。
- 跨账号使用别人的媒体编号被拒。
- 不存在的编号被拒。
- 超过 512KB 的参考图仍然被压到 512KB 以内（压缩逻辑在改成读字节后不能失效）。
- 请求体大小从数十 MB 降到几 KB，可再用审计日志的截断标记核对。