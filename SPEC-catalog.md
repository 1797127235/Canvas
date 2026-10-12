# Spec: catalog 与账号生成

状态：当前开发环境作为实际运行环境，核心多用户与真实文本/图片/视频链路已验证，剩余场景和用户确认见 Pending Tests。属于 [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)。

## 目标

每个账号保存一把 API Key，图片、视频、文本和音频均由服务端使用这把 Key 访问同一个上游。模型列表来自上游 `/models`，不绑定 MiniMax 或其他特定模型。浏览器不提交上游地址、任意请求路径、真实 Key 或可执行脚本。

本地是完整的多用户开发环境；生产代理、HTTPS、备份等部署事项不作为本轮功能实施的阻断。开发阶段不设单文件、账号容量、画布数量额度。

## 配置

`CATALOG_CONFIG_PATH` 指定 JSON 文件，格式见 `server/config/catalog.example.json`。每个配置项包含 `id`、`name`、`upstreamModel`、`adapter`、`capability`、`enabled`、`baseUrl`，不允许 `apiKey`。所有配置项必须使用同一个规范化后的上游根地址，地址含明确的 `/v1` 前缀，不从请求推导。

配置项用于能力、显示名称和 ID 的明确映射，不能扩大 Key 的上游模型权限。请求上游目录后，只对实际返回的模型应用映射；禁用项仍不可用，未列出的上游模型也会显示。能力优先使用配置和上游 `capability`/`capabilities`；没有能力元数据时沿用现有渠道的名称关键词分类，包含 Seedance 和 MiniMax 视频模型。

配置缺失允许身份模块启动，但模型发现报错。指定非法配置时启动失败，错误不输出文件内容或秘密。目录不缓存账号 Key 或账号响应，失败不回退旧浏览器渠道或静态配置列表。

## API

- `GET /api/models`：需登录，使用当前账号 Key 请求上游目录，返回 `{ models: [{ id, name, capability }] }`；未保存 Key 返回 409，上游读取失败返回 502，不暴露地址、Key 或内部协议。
- `PUT /api/credentials`、`GET /api/credentials`、`DELETE /api/credentials`：账号 Key 加密保存，只返回是否已配置及掩码。保存或清除后前端重置目录，迟到响应不能恢复旧列表。
- `POST /api/generations`：需登录，参数为 `{ capability, modelId, input }`；服务端重新查询该 Key 可用模型，校验能力后使用固定路由调用上游。
- `GET /api/generations/:id`、`GET /api/generations/:id/content`：任务按当前账号查询，任务使用创建时保存的上游地址和当前账号 Key，跨账号返回不存在。
- `GET /api/generation-history/:kind`、`PUT/DELETE /api/generation-history/:kind/:id`：按账号和 image/video 类型保存、查询、删除生成历史，保存在 PostgreSQL，不读取旧 IndexedDB 历史。

## 原生生成协议

| 能力 | 固定路由 | 参数与结果 |
| --- | --- | --- |
| 图片 | `images/generations`、`images/edits` | 普通生成 JSON；编辑 multipart，单图 `image`、多图 `image[]`；结果保存账号媒体 |
| 视频 | `videos`、`videos/:id`、`videos/:id/content` | 原生 multipart，秒数、尺寸、清晰度、模式、声音、水印及参考图片/视频/音频原样转发；任务按账号保存，可刷新续查 |
| 文本 | `chat/completions` | 消息、图片上下文和 reasoning_effort，流式响应透传并增量展示 |
| 音频 | `audio/speech` | input、voice、response_format、speed、instructions；二进制音频返回并保存账号媒体 |

视频字段为 `seconds`、`size`、`resolution_name`、`generate_audio`、`watermark`、`mode`；首尾帧使用 `first_frame`/`last_frame`，全能参考使用 `image[]`，另有 `video[]`/`audio[]`。保留原生面板的清晰度、比例、时长、声音、水印，不在服务端夹到 768P 或某个模型的时长。上游拒绝不支持的参数时返回错误，不静默改写。

只实现当前 OpenAI 兼容上游。浏览器旧本地免登录模式仍保留原有 Gemini 和脚本能力，账号后端不执行用户脚本。

## 账号隔离与存储

工作区和历史以有效会话派生的用户 ID 查询。客户端 `X-Account-Id` 只用于检测跨标签换号后的迟到请求，不能授权或替代 Cookie 身份；不匹配时拒绝写入。

工作区读取完成才开放私人页面，切换账号清空旧项目与素材，页面按账号重新挂载。400ms 自动保存串行执行；409 保留当前编辑并提示先导出，网络失败显示错误；显式退出先 flush。媒体本地开发可直接保存服务端磁盘，也可配置 MinIO，上传使用流，不设置业务额度；读取支持 Range 与 HEAD。ZIP 导入把媒体重新上传到接收账号并替换 key/URL。

## 验收

新增/调整用例见 `server/tests/catalog.test.ts`、`server/tests/generation-http.test.ts`、`server/tests/account-media.test.ts`、`web/tests/catalog-generation.test.ts`。专项后端 14/14、前端 5/5、两端类型检查通过；真实数据库双账号隔离和独立 Chrome 主流程通过，真实文本/图片/视频生成、账号媒体保存与重启恢复通过。实际未执行场景记在 `docs/content/docs/progress/pending-test.mdx`，不以核心流程通过代替全部参数和用户验收。未执行构建。
