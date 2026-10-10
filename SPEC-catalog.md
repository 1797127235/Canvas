# Spec: catalog

状态：待审阅。属于已批准的 [CAPABILITY-MAP.md](./CAPABILITY-MAP.md)；本文件不是已实现功能。

## Objective

让多用户业务从服务端获取唯一上游服务的可用模型和明确能力，并让后续 generation 通过模型 ID 取得可信调用配置。用户只能选择模型，不能提交上游地址、协议、脚本或实际模型名来改变服务端调用目标。不提供管理后台，不读取用户 API Key，不请求上游发现模型。

先交付目录、校验和模块契约，避免将配置文件存在误当作生成功能已可用。credentials、media、workspace 和 generation 各自按能力图推进。

## 已有事实与本次提案

- `web/src/stores/use-config-store.ts` 当前定义 image/video/text/audio 四种能力及 openai/gemini 两种渠道格式；本地模型允许 script，不能原样搬入服务端执行。
- `server/src/config.ts` 已用 zod 校验环境，`server/src/index.ts` 统一启动，HTTP 错误遵循 `{ error: { code, message } }`。
- 提案：独立 JSON 文件保存目录，通过 `CATALOG_CONFIG_PATH` 指定。未设置时加载空目录，保留 identity 开发能力；配置了文件但读取、解析或校验失败时拒绝启动，不静默回退。
- 提案：首期模型能力仍为 image/video/text/audio。每个模型显式指定内置 adapter，能力由 adapter 定义；不猜名称，不接受脚本插件或任意请求路径。
- 提案：目录读取公开，无副作用；只有公开模型元数据，不暴露上游地址或路由。后续 generation 仍须独立鉴权，公开目录不能授权调用。

## Tech Stack / Project Structure

沿用 Node.js 24、TypeScript、Express 5、zod 4、Node 标准库和 Node 测试，无新依赖，无数据库/schema 改动。

- `server/src/catalog/`：JSON 校验、只读目录、公开路由、可信模型解析及协议路由定义。
- `server/config/catalog.example.json`：空模型配置示例，不提供秘密或声称某模型已可用。
- `server/tests/catalog*.test.ts`：不访问数据库的配置、契约和 HTTP 测试。
- `web/src/services/api/catalog.ts`：同源目录读取与响应校验。
- `SPEC-catalog.md`、`tasks/plan.md`、`tasks/todo.md`：本模块规格、附加计划和任务。

## Configuration Contract

配置文件结构：

```json
{
  "upstream": { "baseUrl": "https://api.example.com/v1" },
  "models": []
}
```

示例只演示结构，`api.example.com` 不是有效生产上游；配置示例不直接启用模型。实际模型记录：

```typescript
type ConfiguredModel = {
    id: string;
    name: string;
    upstreamModel: string;
    adapter: AdapterId;
    enabled: boolean;
};
```

- 一个文件只有一个 upstream。所有模型调用都使用这一 baseUrl；它是明确的 API 根路径，包含 `/v1` 或 `/v1beta` 等必要前缀，程序不猜测、不重复补前缀。
- 正式环境上游要求 HTTPS；开发可配置 loopback HTTP mock。URL 不得包含用户名、密码、query 或 fragment。上游不会从请求参数、模型名或用户 Key 推导。
- 模型 ID、展示名称、实际模型名为非空字符串；ID 全目录唯一，保留配置顺序。一个实际模型可用不同 ID 显式配置不同适配器。
- `enabled` 必填。只有 true 的记录进入公开目录和 generation 的可用解析；禁用与不存在对调用方统一不可用。
- 验证未知字段与未知 adapter，禁止 script、每模型 baseUrl、headers 或 endpoint 等任意执行/路由配置。
- 配置启动时读入不可变快照，修改后重启。无文件监听、热更新或配置写入 API；多个实例须部署同一配置。
- 校验错误只报告字段位置，不输出完整配置、环境值或文件内容；任何错误都不能使原有旧本地渠道成为回退上游。

## Adapter Contract（提案，须确认所需上游协议）

| adapter ID | capability | 标准路由定义 |
|---|---|---|
| openai-chat | text | POST chat/completions |
| openai-images | image | POST images/generations；参考图片场景 POST images/edits |
| openai-speech | audio | POST audio/speech |
| openai-videos | video | POST videos；查询 videos/:id；读取 videos/:id/content |
| gemini-content-text | text | POST models/:model:generateContent |
| gemini-content-image | image | POST models/:model:generateContent |
| gemini-video | video | POST models/:model:predictLongRunning；查询 operations/:id |

catalog 交付固定路由选择与安全路径编码，内部返回适配器定义和可信模型映射。不得将模型名、上游返回的任务 ID 当作绝对 URL 或未经编码的路径插入；不允许自动跟随上游返回的任意路径调用。

catalog 不持有 Key，不发送计费请求、不下载媒体、不实现轮询或解析生成结果。请求参数、认证头、媒体校验、响应解析及真实上游联调属于 generation；后者必须依据实际上游文档实现，不可因 adapter 名称就宣称服务支持所有兼容接口。尤其原视频代码中的 image[]、generate_audio、watermark 等不是统一标准保证，不在本模块擅自照搬。

若实际唯一上游只支持 OpenAI 兼容协议，可在实施前缩减适配器范围；禁止为尚未确定的供应商扩展大量兼容分支。

## Public API

`GET /api/models` → `200 { models: PublicModel[] }`

```typescript
type ModelCapability = "image" | "video" | "text" | "audio";
type PublicModel = { id: string; name: string; capability: ModelCapability };
```

- 公开、只读，返回全部已启用的有限配置清单，按配置顺序；不增加人为条数截断或分页上限。
- 空目录返回 `{ models: [] }`，不伪造默认模型、不向上游查询，不因空目录使 identity 不可用。
- 不返回 baseUrl、upstreamModel、adapter、Key、禁用记录或文件路径。沿用 no-store 和通用 JSON 错误。
- 不新增 UI 页面。后续账号配置与生成页面直接使用 `services/api/catalog.ts`，不读取旧配置 store 获得账号模型。

## Internal API

- `loadCatalog(path, nodeEnv)`：未配置返回空目录，指定配置无效则抛脱敏配置错误。
- `listModels()`：返回公开模型数据副本，外部修改不能影响快照。
- `resolveModel(id, expectedCapability)`：只有启用且能力一致时返回可信 `{ baseUrl, upstreamModel, adapter }`；其他输入返回明确不可用结果，不回退默认模型。
- generation 接口只接收用户选中的 ID，再调用 resolveModel；不能信任浏览器传来的 name/capability/baseUrl/adapter。
- 本模块没有生成接口。生成鉴权、用户 Key 和请求执行属于后续模块；正常身份模式私人业务仍不开放。

## Code Style

沿用现有四空格、双引号、显式 `.js` 后端相对导入；用 zod 在文件/API 边界校验，逻辑保持短小，不引入类、DI 框架或通用插件运行器。

```typescript
export function toPublicModel(model: ConfiguredModel): PublicModel {
    return { id: model.id, name: model.name, capability: adapters[model.adapter].capability };
}
```

## Commands / Testing Strategy

```bash
cd server && node --import tsx --test tests/catalog*.test.ts
cd web && bun test tests/catalog.test.ts
cd server && bun run typecheck
cd web && bun run typecheck
```

仅在获得验证授权时执行。目录测试无数据库，不运行会清库的 identity 全量测试。按项目规则不自动执行构建；HTTP 验收使用独立 loopback server，不替换用户测试进程。

测试覆盖：文件缺失、非法 JSON、未知字段/adapter、重复 ID、非法上游地址、空目录、禁用过滤、能力匹配、错误脱敏、快照不被外部修改、路由路径编码、防止任务 ID 越出固定路由、公开输出无内部字段、浏览器 API 失败/非法返回不回退旧模型。

## Boundaries

- Always：复用 identity 服务结构，启动校验，明确配置与公开输出分离，保持旧本地免登录开发功能。
- Ask first：改变超时/重试/数量/并发等边界、新增依赖、实际上游请求、部署、数据库操作及业务数据迁移。
- Never：提交 Key、让用户配置服务端上游、执行模型脚本、从名称猜能力、静默默认模型/协议、把目录交付说成生成可用。

## Success Criteria

- CAT-01：指定配置非法时启动失败且不披露配置内容；未指定时目录为空。
- CAT-02：唯一上游与内置适配器通过校验，ID 唯一；禁用模型不公开也不能解析。
- CAT-03：GET /api/models 可独立验证，精确输出 id/name/capability，不暴露调用配置。
- CAT-04：内部解析强制模型启用及能力匹配，不信任客户端附带的配置字段。
- CAT-05：固定路由安全编码，模型名/任务 ID 不能替换上游或越出路由。
- CAT-06：前端可读取并校验目录，故障/空列表不使用旧浏览器配置兜底。
- CAT-07：identity 与原本地免登录开发行为不改变；实现、测试和待用户确认状态准确记录。

## 待确认

1. 上述 JSON 配置、公开目录和显式适配器范围是否批准；若实际唯一上游只用一种协议，可减少 adapter。
2. 真实上游的 API 根地址和模型列表待部署/联调配置，不从旧浏览器中收集秘密，也不要求现在提供 Key。
3. 本阶段不新增运行边界；identity 未确认的生产参数继续留在原任务中，不阻断无外部调用的目录开发。
