# Tasks: identity

状态：规格与计划已批准，identity 本地实现与验收已完成主要路径；生产运行参数和部署关卡尚未完成，不等于多用户业务系统或公开上线已完成。

## 已实现并验证

- [x] Task 1a/1b：独立 Node.js 24 / Express 5 后端、Bun 锁文件、配置校验和启动入口。启动验证数据库/schema，关闭时先等待 HTTP 请求收尾再关闭连接池。
- [x] Task 2/2a：PostgreSQL users/sessions schema、参数化仓储、同 client 事务、独立测试库保护和 loopback HTTP 测试支撑。当前本机数据库版本为 PostgreSQL 16，不宣称部署了 17。
- [x] Task 2b：同源来源校验、4 KiB JSON、压缩拒绝、已挂载路由前的内容类型检查、禁缓存及统一错误；异步数据库/哈希错误进入 Express 错误出口，不发 Cookie。
- [x] Task 3：32 字节随机 SID、SHA-256 摘要存储、固定 7 天会话、事务回滚、重建 pool 后持久化、撤销及并发撤销验证。
- [x] Task 4/4a：规范化邮箱、8～128 可打印 ASCII 密码、Argon2id、未知账号等效验证、PostgreSQL 固定窗口限流（登录 30/15 分钟、注册 10/小时）；启动时清理过期会话和窗口记录，不设置未经确认的定时周期。
- [x] Task 5：注册账号与首次会话同事务，唯一约束裁决重复并发注册，提交后设置 Cookie。
- [x] Task 6：同账号登录事务内行锁，5 次失败锁定 15 分钟，重复尝试不延长，到期从 0 累计，成功清零；正确登录等待期间新提交的锁定不能被覆盖。
- [x] Task 7：查询会话统一返回 `{ user: { id, email }, expiresAt }`；退出撤销当前会话、清 Cookie、可重复、多设备独立。`readCurrentUser` / `requireUser` 只从数据库会话派生身份，不信任客户端 userId。
- [x] Task 8：四态用户 store；查询响应版本保护，登录/退出期间不并发刷新，清会话后旧响应不能恢复身份；失败退出保留状态并提示。
- [x] Task 9：登录/注册表单即时邮箱规范化和密码规则、本站返回路径、中文错误，注册不发送确认密码。
- [x] Task 10/10a：正常身份模式游客不挂载私人组件，登录后也不挂载未隔离的旧本地画布/素材/生成页面；旧配置、Agent 自动连接与面板仅本地免登录模式开放。不删除、不迁移旧 IndexedDB，不改本地 Agent 协议。
- [x] Task 11：游客模板只读预览、克隆跳登录、登录后回原预览且不自动克隆；未接入 workspace 前已登录用户也不写旧本地画布或素材。
- [x] Task 12：BroadcastChannel 仅传状态事件，退出不回环，页面可见时刷新；双标签页退出与会话过期验证。
- [x] Task 13：Vite 同源 `/api` 代理，默认 `127.0.0.1:4100`，`VITE_API_PROXY_TARGET` 可设置联调目标；保留来源校验，不启用凭证 CORS。
- [x] Task 14（本地验收）：后端 54/54、前端 14/14 全部测试通过，两端类型检查通过；独立 Chrome profile 验证游客跳转、非法密码、邮箱规范化注册、刷新、退出、双标签页同步、错误密码、重复注册、网络错误、退出失败、账号锁定、到期解锁、会话过期、模板返回与无自动克隆。浏览器无未捕获异常。

测试命令：`cd server && bun run test` / `bun run typecheck`，`cd web && bun test` / `bun run typecheck`。后端测试必须使用独立 `TEST_DATABASE_URL` 且数据库名以 `_test` 结尾，不得在用户手动测试库或业务库执行全量清理。本轮另建回归库，未清理用户手动注册账号。未执行构建或生产部署。

## 尚未完成的关卡

- [ ] Task 0：确认连接池/数据库/HTTP 边界、过期数据定期清理与保留策略；不得静默采用提案的 60 秒周期或 SQL/锁超时。
- [ ] 生产反向代理可信地址/网段及 IP 识别、HTTPS 入口和正式数据库配置、依赖审计、备份/隐私流程与上线验收。开发仍用直接连接 IP，Vite 请求共用来源额度。
- [ ] 用户最终验收确认；待确认内容继续留在 `pending-test.mdx`，不写入正式功能说明。
- [ ] workspace/media/credentials/catalog/generation 的规格与实现：identity 只提供可信用户 ID，不宣称资源隔离、云同步、对象存储或服务端代发请求已实现。

## 开发例外

按用户要求，Vite 开发默认 `VITE_AUTH_BYPASS` 开启：不查询身份后端，恢复原本地私人业务、配置和 Agent；不伪造账号、不放开后端鉴权。身份联调设置 `VITE_AUTH_BYPASS=false` 并重启。生产构建与预览不启用豁免。

## Notes

- 修改边界值、引入新依赖、提交、部署与发布仍需授权。
- 新会话和资源授权必须使用数据库当前有效会话；请求通过授权后已开始执行的操作不因后续退出倒退取消。
- 定期清理失败不会延长会话，也不能放行限流；当前仅启动时清理，不承诺过期数据物理删除时效。

## 下一模块：catalog（已实现首个纵向切片，完整生成适配仍待验收）

依据：`SPEC-catalog.md` 及 `tasks/plan.md` 文末。与 identity 同属多用户能力图；本轮已实现 catalog、credentials、workspace、media、generation 的首个服务端纵向切片，保留生产待办，不把未配置的 MinIO/真实上游写成完成。

- [x] CAT-T1：内置协议与配置校验（依赖：无）。已实现 OpenAI-compatible 固定 adapter、单上游配置校验和启用模型投影。
  - 验收：固定路由/能力明确，未知 adapter/字段、重复 ID、非法上游拒绝；任务 ID/模型名不能越出固定路径。
  - 文件：`server/src/catalog/adapters.ts`、`config.ts`、`server/tests/catalog-config.test.ts`、`catalog-adapters.test.ts`。
  - 验证：`cd server && node --import tsx --test tests/catalog-config.test.ts tests/catalog-adapters.test.ts`。
- [x] CAT-T2：只读快照、公开投影与解析（依赖：T1）。空目录和 JSON 配置已支持，禁用模型不公开、不解析。
  - 验收：禁用不公开/不解析，能力匹配，无内部字段暴露，返回结果被修改不影响快照；未设置配置为空，指定无效配置失败且错误脱敏。
  - 文件：`server/src/catalog/catalog.ts`、`server/tests/catalog.test.ts`、`server/config/catalog.example.json`。
  - 验证：`cd server && node --import tsx --test tests/catalog.test.ts`。
- [x] 关卡 A：T1/T2 验证有证据后再接入实际启动，不静默引入上游网络调用。服务端 typecheck 通过，目录无配置时返回空列表。
- [x] CAT-T3：目录 HTTP 路由（依赖：T2）。GET /api/models 已接入，冒烟返回 200 和空目录。
  - 验收：GET /api/models 返回全部启用公开模型，空目录为 200；错误契约、禁缓存与现有 app 一致。
  - 文件：`server/src/catalog/routes.ts`、`server/tests/catalog-http.test.ts`。
  - 验证：`cd server && node --import tsx --test tests/catalog-http.test.ts`。
- [x] CAT-T4：启动配置接入（依赖：T3）。启动已接入 catalog、credentials、workspace、media、generation；新增 SQL 已应用至隔离开发库。
  - 验收：未配置路径仍可启动 identity，指定非法目录拒绝启动，样例不含 Key/启用虚假模型。
  - 文件：`server/src/config.ts`、`index.ts`、`server/.env.example`、`server/tests/config.test.ts`。
  - 验证：目录测试、配置测试；身份 HTTP 独立冒烟，不清理手动测试账号。
- [x] CAT-T5：前端目录 API 服务（依赖：T3）。前端已加入账号配置面板、目录服务和 API Key 掩码管理。
  - 验收：校验公开响应、空列表/网络/HTTP 错误，不回退旧本地渠道，不持久化服务端调用配置。
  - 文件：`web/src/services/api/catalog.ts`、`web/tests/catalog.test.ts`。
  - 验证：`cd web && bun test tests/catalog.test.ts`。
- [x] 关卡 B：目录测试、授权后的两端类型检查和独立 HTTP 冒烟；不执行构建或真实计费请求。后端/前端 typecheck 通过，前端 14/14 通过；Key、工作区版本冲突、目录和未配置媒体 HTTP 冒烟通过。
- [ ] CAT-T6：文档收尾（依赖：T4/T5）。当前文档已记录纵向切片，仍需补真实模型目录和 MinIO 部署验收。
  - 验收：记录实际完成、未执行验证及后续 generation 边界；更新能力图/文档索引/TODO/Pending Tests/CHANGELOG，不把草案列成已实现功能。

批准 catalog 之前仅编写本节与规格，不勾选实施任务。无新依赖、数据库变更、数量/超时/重试/并发边界。
