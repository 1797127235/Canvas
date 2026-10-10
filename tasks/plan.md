# Implementation Plan: identity

状态：已批准。模块：`identity`。依据：[SPEC-identity.md](../SPEC-identity.md)，规格已批准。本文的技术方向、阶段性开放策略和四项参数已批准；[任务清单](./todo.md) 已批准。已确认 Task 0 的最小会话服务和 PostgreSQL 固定窗口限流调整；Task 1a 的依赖与编译配置已完成。当前 identity 本地主要实现及验收已完成；54 项后端、14 项前端测试和两端类型检查通过，独立浏览器主要流程通过。下方数据库/HTTP运行边界、清理周期及生产代理事实仍待确认，不写入业务实现；现已启用启动时过期清理，不引入定时周期。

## Overview

交付邮箱密码注册、登录、当前会话查询、退出以及游客与登录用户的前端访问入口。游客继续使用现有内置模板只读预览，私人业务数据由后续模块按账号持久化。

本计划仅覆盖 identity，不能把它的完成等同于多用户项目完成。正式任务清单已写入 `tasks/todo.md`，已批准；产品待办仍记在 `docs/content/docs/progress/todo.mdx`。

## 当前实现证据

注册、登录、会话和来源限流已落地，统一 `readCurrentUser` / `requireUser` 提供可信身份；正常身份模式按中间阶段边界关闭未隔离的旧本地业务写入。用户要求本地 Vite 默认免登录开发，通过 `VITE_AUTH_BYPASS=false` 可恢复身份联调。测试与浏览器证据详见 `tasks/todo.md`，正式生产上线尚未验证。

## Existing Evidence（首次规划时）

- `web/package.json` 和 `web/bun.lock`：现有前端使用 Bun 管理依赖、Bun 测试。
- `web/src/router.tsx`：当前所有业务路由均未设登录访问控制。
- `web/src/stores/use-user-store.ts`：已有空的用户 store，定义的是 `LocalUser`，尚无真实会话逻辑。沿用该位置改为真实身份状态，不再新建并行的 `stores/identity.ts`。
- `web/src/components/layout/user-status-actions.tsx`：可复用账号入口位置，现有组件尚无登录、退出按钮。
- `web/src/pages/prompts/components/workflow-preview-modal.tsx`：已有只读预览和克隆按钮，前者可复用。
- `web/src/services/api/templates.ts`：克隆仍写入本地媒体和画布 store；不能只在 UI 隐藏按钮，服务动作入口也要拦截。
- `web/src/services/api/request.ts`：仅有查询参数辅助函数，不是通用身份 HTTP 客户端；身份请求直接封装到 `services/api/identity.ts`。
- 首次规划时不存在 `server/` 或任务文件，未覆盖其他未完成计划；当前已创建计划、任务文档及后端基础配置代码，但没有数据库或认证实现。

## Architecture Decisions（方向已批准）

### 运行时与依赖

| 用途 | 提案 | 原因及约束 |
|---|---|---|
| 运行时 | Node.js 24 LTS | 与本机 Node 24 环境一致，后端实际在 Node 下执行。 |
| 包管理 | Bun，独立 `server/bun.lock` | 沿用仓库约定；不混入另一份后端锁文件。确切 Bun 和依赖补丁版本在安装前固定。 |
| HTTP | Express 5、TypeScript、tsx | 沿用已批准技术栈；开发通过 tsx，生产执行编译后的 JS。 |
| 数据库 | PostgreSQL、`pg`（本机验证为 16） | 简单参数化 SQL 和显式事务，不增加 ORM；共享测试数据库版本与开发版本。 |
| 输入 | `zod` | 成熟邮箱及字段校验；统一前后端密码规则，不自制邮箱解析器。 |
| 密码 | `argon2`，Argon2id | 支持已批准的 128 字符密码，不使用会截断长密码的方案。 |
| 会话 | 项目内最小会话服务，已批准 | 用 Node crypto 生成随机 SID 与 SHA-256 摘要，PostgreSQL 保存账号归属和固定到期时间；Cookie 编解码使用成熟库/Express API，不手写协议解析。不采用 express-session、connect-pg-simple 或 MemoryStore。 |
| 安全响应 | `helmet` | 复用成熟安全头方案，结合既有媒体和页面资源设置，不盲目复制 CSP。 |
| 测试 | Node `node:test` + tsx，HTTP 测试使用 Node fetch | 避免为了后端测试改用 Bun 运行时，不额外引入大型测试框架。 |

Task 1a 已按下方精确版本创建独立 manifest 和锁文件；`bun install --ignore-scripts` 完成，冻结无脚本安装无变更，未执行任何安装脚本。完整漏洞/传递源码审核尚未完成，不等于生产安全验证。

### 会话服务与事务验证关卡

Task 0 已批准调整为最小会话服务，不再实现 express-session Store。connect-pg-simple 的 upsert 允许删除后重建同一 SID，express-session 的自动收尾保存也会引入额外事务整合；本期不需要动态 Session 对象，这些机制没有必要引入。

1. 使用 Node crypto 的成熟随机生成与 SHA-256 摘要 API；Cookie 保存不可预测的原始 SID，数据库只保存 `sidHash`、`userId`、固定 `expiresAt`，不保存原始 SID、序列化 Session 对象或设备指纹。随机凭证长度在实现前说明并确认。
2. 注册时账号与首次会话的 INSERT 使用同一 `pg.PoolClient` 事务；登录成功后同样在事务中创建新会话。依据 [node-postgres Transactions](https://node-postgres.com/features/transactions)，禁止用独立 pool.query 混入事务。
3. 事务提交成功后才设置 Cookie、发送成功响应。失败回滚且不发放凭证；提交结果未知时不自动重试，不靠删账号模拟回滚。
4. 每次受保护请求按数据库时间查询 `expiresAt > clock_timestamp()` 的会话。普通请求不写会话、不续期、不重新设置到期时间，Cookie 和数据库均保持固定 7 天。
5. 退出删除当前 SID 摘要对应记录，旧凭证失效；不存在自动保存回调或通用 session upsert，迟到读请求不能恢复已删除会话。清理到期记录不影响认证拒绝，无需永久撤销墓碑。
6. Task 3 使用真实 HTTP 与并发测试验证原子回滚、后端重启持久化、固定到期和多设备独立。撤销不倒退取消已通过认证并开始执行的请求；后续请求必须拒绝旧 SID。

Task 3 仍是硬关卡。方案批准不是运行验证通过，不引入事务上下文绑定或跨请求共享 client。

### 数据结构与初始化

拟新增账号表：服务端生成 UUID 主键、规范化唯一邮箱、密码哈希、连续失败计数、锁定截止时间、创建时间。计数与时间不能仅放进单进程内存。

会话表保存 SID 摘要、当前用户 ID 和固定截止时间，不存储通用 session 数据；不收集设备指纹或完整客户端资料。

- `server/sql/001-identity.sql`：首次 schema，包括账号唯一约束和会话所需索引。
- `server/src/db.ts`：连接和事务入口，SQL 参数化。
- 使用明确命令应用全新后端 schema，不在请求到来时自动建表，不迁移 IndexedDB，不修改既有本地数据。
- 独立 `TEST_DATABASE_URL`；测试显式验证不是业务数据库。测试清理仅限该测试库。
- `DATABASE_URL`、`RATE_LIMIT_SECRET`、`APP_ORIGIN` 等通过环境配置和 `.env.example` 占位符声明，秘密不提交。
- 反向代理可信范围必须匹配实际部署链路，不能配置全信任代理或盲目信任客户端 `X-Forwarded-For`。

### 注册与登录

- 规范化、校验输入后进行密码哈希或校验；未知邮箱也做等效密码校验工作，避免明显的计算路径差异，不能宣称完全消除时间侧信道。
- 注册依赖唯一约束裁决并发；账号和会话在同一事务内创建。
- 登录的失败计数、到期解除、成功清零和锁定判定在数据库事务中串行化；不能“读计数→无锁更新”。密码校验和锁处理的临界区需审阅，避免过长数据库锁和无限排队。
- 新会话不撤销其他设备；当前浏览器换新会话时不得复用旧凭证。退出以数据库撤销结果为准。
- 统一错误形状及 HTTP 状态，禁缓存，日志不写认证正文或 Cookie。

### 前端身份边界

- 沿用 `web/src/stores/use-user-store.ts`，状态明确为加载中、游客、已登录、错误；不持久化认证 token。
- `web/src/services/api/identity.ts` 封装四个已批准接口，浏览器同源 Cookie，禁止自动重试注册或登录；网络结果不确定时查询会话。
- `/login`、`/register` 独立页面，复用主题与 Ant Design 表单；返回目标使用标准 URL API 校验为本站相对路径。
- 页面守卫不挂载私人组件，防止其 effect 在守卫后仍读本地数据；操作入口在写入/调用开始前验证身份。
- 多标签页用 `BroadcastChannel` 通知状态变化，只传事件，不传 token 或用户业务内容；页面重新可见时再次查询会话，不设置未批准的轮询周期。
- 游客预览继续复用现有 Modal，通过可恢复的模板 ID 记录返回入口，不保存未提交业务内容；登录成功不自动克隆。
- 保留现有主题、快捷键和布局，不在此阶段重构本地 Agent；游客身份不能解锁被拦截的真实业务操作。

## 已批准的中间阶段边界

现有画布、素材、历史和 AI 配置是浏览器本地数据，并未按新账号隔离。仅加登录守卫后开放，会让同一浏览器切换账号时看到同一份历史数据或继续使用旧 Key，与多用户目标冲突。

已批准：identity 阶段验证游客浏览和认证完整链路；个人工作台入口可进入，但暂不挂载旧本地私人列表和编辑器，也不开放模板克隆、上传、生成或 API Key 操作。等待 `workspace`、`media`、`credentials`、`generation` 实现并验收后再逐项开放，既有 IndexedDB 不删除、不迁移。

这是已批准的阶段性行为安排；identity 完成不意味着所有真实操作已经可用。本期最终产品仍按已批准规格提供登录后真实操作。

## Dependency Graph

```text
后端基础与独立数据库
    → 会话事务/固定到期/并发撤销验证
        → 注册与会话查询 API → 注册 UI（首条完整用户路径）
        → 登录与账号锁定 API → 登录 UI
        → 退出 API → 标签页同步
    → 前端身份 store 与路由/操作守卫
        → 游客预览返回路径与登录拦截
            → 全链路验收与文档
```

API 契约已由规格定义。后端基础完成后，登录表单与纯输入测试可独立准备；共享 store、路由、会话表及登录计数必须串行修改。默认不启动多代理或工作流。

## Delivery Slices（计划顺序，不是已批准任务）

1. 后端最小启动、数据库配置和会话高风险验证。检查账号/会话原子性、固定到期、并发退出无复活，失败则停下修订方案。
2. 注册纵向路径：输入规则、账号唯一约束、注册即登录、会话查询、前端注册页与 store；不连接旧私人数据。
3. 登录纵向路径：通用错误、锁定及成功清零、登录页、本站返回入口。
4. 退出纵向路径：数据库撤销、Cookie 清除、多设备独立、标签页同步及失败提示。
5. 游客入口与业务操作边界：复用模板预览，拦截克隆及其他真实入口，防止旧私人组件挂载；按确认后的中间阶段边界处理已登录入口。
6. 集成与浏览器验收、待测试记录和版本级变更记录；未执行的验证明确列为待验收。

Tasks 阶段再将每条路径拆成单次会话、至多约 5 个文件的任务；不把注册后端、全部 UI 和认证守卫堆到一个任务。

## Verification Checkpoints

- 关卡 A：会话库方案满足原子性、固定 7 天、重启持久化和并发撤销，确认后继续用户路径。
- 关卡 B：注册和登录纵向路径达到 ID-03～ID-09，锁定并发与数据库故障测试有证据。
- 关卡 C：退出、游客返回、跨站拒绝达到 ID-01、ID-10～ID-13；私人模块尚未落地时，ID-02、ID-14 验证统一身份入口，不宣称业务模块已完成隔离。
- 最终：逐项核对规格 14 项标准，浏览器使用独立测试页面；更新真实已实现项目，不将计划内容放进待测试清单冒充交付。

按项目要求，不自动运行测试、类型检查、构建或数据库初始化。用户授权后执行的拟新增后端脚本为：

```bash
cd server && bun run dev          # tsx src/index.ts
cd server && bun run test         # Node + tsx + node:test，明确列出测试文件
cd server && bun run typecheck    # tsc --noEmit
cd server && bun run build        # tsc
cd server && bun run start        # node dist/src/index.js
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/sql/001-identity.sql
```

测试库准备另用 `TEST_DATABASE_URL`，脚本在 Tasks 定义；不要用上面的业务数据库命令代替测试准备。

## 已批准的边界值（已启用）

| 环节 | 已批准默认值 | 超出或失败时处理 |
|---|---|---|
| 密码哈希 | Argon2id，内存 19 MiB、迭代 2、并行度 1 | 哈希或校验内部错误返回通用 500，不创建账号/会话；上线前按硬件测量，不自动降低成本。 |
| 身份 JSON 请求 | 最大 4 KiB，禁止压缩请求体 | 超出返回 `413 PAYLOAD_TOO_LARGE`，压缩编码拒绝；发生在哈希或数据库写入前。 |
| 登录来源限流 | 同一来源 IP 每 15 分钟最多 30 次登录请求 | 超出返回 `429 RATE_LIMITED` 和 Retry-After，不继续密码校验，不额外累计账号失败次数。 |
| 注册来源限流 | 同一来源 IP 每 1 小时最多 10 次注册请求 | 超出返回 `429 RATE_LIMITED` 和 Retry-After，不创建账号。共享网络用户也会共用此额度。 |

来源限流与已批准账号锁定是两套机制，计数需共享且不因进程重启清零。计数存储、可信代理和 IP 数据最短保留方案需明确后才能落实；不使用单实例内存限流作为生产最终方案。超过窗口后不保留完整 IP 历史；持久化方案提出时说明实际删除机制。

过期会话可在身份后端启动时显式清理，认证拒绝不依赖清理是否执行；若需周期清理，另行说明周期，不能静默采用存储库随机 15 分钟默认清理。

任何库或平台隐含的超时、连接池、请求大小、重试及并发边界必须在实施前审阅；本表不是对所有默认值的批量授权。

## Risks And Mitigations

| 风险 | 处理 |
|---|---|
| 会话库自动 touch/save 导致续期、事务外写入或退出后复活 | 高风险验证先行，固定截止时间服务端校验；不满足则停下更换提案。 |
| 旧 IndexedDB 数据与新账号身份混用 | 不自动开放旧私人页面，不迁移或删除旧数据，等待后续模块。 |
| 账号锁定可被故意触发，来源 IP 限流影响共享网络用户 | 清楚展示取舍；限流数值已批准，具体存储和窗口方案仍需落实，不能宣称解决全部滥用。 |
| 不验证邮箱、不提供找回密码 | 已批准本期范围，但需向用户提示真实风险，不暗示邮箱归属经过验证。 |
| 存储、时钟与并发边界不一致 | 数据库权威时间，测试到期瞬间、并发登录及退出；浏览器时间只用于显示。 |
| 来源校验或代理配置错误 | 配置固定 APP_ORIGIN，缺失或非法配置拒绝启动；拒绝缺失/错误来源的状态变更，匹配实际代理链。 |
| 本地 Agent 可从现有入口触达 | 不改造 Agent，验收游客入口不能绕过真实操作限制；发现冲突先提出，不顺手改通信协议。 |
| 计划被误认为完成或公开上线许可 | 计划、任务、实施分开批准；生产隐私流程、部署验证和后续模块仍是上线关卡。 |

## Remaining Decisions And Gates

1. 运行时、库、数据库结构方向及验证关卡已批准；精确依赖补丁版本在安装前锁定并审阅，不宣称现在已安装。
2. identity 中间阶段暂不开放旧本地私人页面与真实操作的策略已批准，待后续模块接入服务端后开放。
3. 表中 4 项边界值已批准；来源限流的窗口算法、共享存储、IP 保留及删除和可信代理方案仍需落实，批准数值不等于批准任意实现。
4. 已批准最小会话服务替代 Store；随机凭证长度、Cookie 编解码依赖在实现前明确；事务原子性和不可复活行为仍需实际验证。
5. 公开上线前仍需定义账号数据保留、注销、备份和人工处理；本计划不扩大 identity 功能范围来替代这些决策。

任务清单已批准，会话服务和 PostgreSQL 固定窗口方案已批准。Task 1a 仅建立依赖和编译配置，可先推进；未获批的运行边界在 Task 1b/数据库/清理实现前继续确认，Task 0 不整体勾选。批准计划不等于授权执行测试、数据库操作、提交或发布。

## Task 0 审阅记录与补充提案（待确认）

### 运行环境与精确依赖候选

只读命令确认本机 Node `24.18.0`、Bun `1.3.14`。先从 npm 注册表查询以下候选版本，之后在 Task 1a 无脚本安装并生成 `server/bun.lock`；查询和安装成功都不是漏洞审计或生产兼容性证明。

| 类别 | 精确版本候选 |
|---|---|
| 运行时及包管理器 | Node `24.18.0`、Bun `1.3.14` |
| 生产依赖 | express `5.2.1`、pg `8.23.1`、zod `4.6.5`、argon2 `0.45.1`、helmet `8.3.0` |
| 已批准新增限流库 | rate-limiter-flexible `11.2.1` |
| 开发工具 | typescript `5.9.3`、tsx `4.23.15` |
| 类型声明 | @types/node `24.19.1`、@types/express `5.0.6`、@types/pg `8.23.1` |

不直接选择注册表最新 TypeScript `7.0.2` 和 Node 26 类型：本项目前端仍使用 TypeScript 5，后端运行 Node 24，本期无需增加编译器大版本升级的变量。PostgreSQL 17 的精确补丁/镜像 digest 在确定数据库运行环境后记录，不声称本机已安装。

`express-session`、`connect-pg-simple` 及其类型包不加入后端依赖，理由见会话服务方案。`pg` 的原生扩展不启用。实际传递依赖只在首次无脚本安装生成锁文件后确定，随后再次审阅，不能把顶层元数据当完整供应链检查。

### 安装脚本审阅

- 首次安装使用 `bun install --ignore-scripts`，manifest 设置 `trustedDependencies: []`，不继承 Bun 内置默认可信名单；后续由锁文件执行冻结安装。
- `argon2@0.45.1` 的 install 为 `cross-env ZERO_AR_DATE=1 node-gyp-build`。它可能先验证已打包 native 二进制，失败后调用 node-gyp 本机编译；不是普通纯 JS 安装，执行前需确认本机二进制适配与必要工具，不自动安装全局编译工具。
- `tsx@4.23.15` 依赖 esbuild `0.28.x`，已审阅 `esbuild@0.28.0` 的 postinstall：验证/准备平台二进制，缺少可选包时可能调用 npm 或下载。优先使用锁定的平台可选包，禁止隐式跨包管理器安装；如果确需执行脚本，先确认具体安装到的版本与源码，再单独放行。
- 除必要且实际审阅通过的脚本外不加入 trustedDependencies；允许安装某个包不等于批量授权其所有传递依赖脚本。没有执行上述任何脚本。

来源：[Bun lifecycle](https://bun.sh/docs/pm/lifecycle)、[argon2 发布元数据](https://registry.npmjs.org/argon2/0.45.1)、[node-gyp-build 安装入口](https://unpkg.com/node-gyp-build@4.8.4/bin.js)、[esbuild 安装入口](https://unpkg.com/esbuild@0.28.0/install.js)。发布元数据比默认分支 README 更能代表所选版本；仍需对实际锁文件审核。

### 来源限流方案（库与固定窗口已批准，保留及清理待确认）

- 新增成熟库 `rate-limiter-flexible@11.2.1` 的 `RateLimiterPostgres`，复用 PostgreSQL，不新增 Redis，不自制窗口解析/原子计数算法。
- 采用从该 IP 首次请求起算的固定窗口：登录 30 次/15 分钟、注册 10 次/小时。窗口到期后重新计数，不是“任意滚动时间段最多 N 次”；交界前后可以短时集中请求，这项取舍已批准。
- 所有同一部署实例共用数据库、表与密钥。每次请求原子 consume，成功登录不清空来源额度；超额请求不能延长窗口，不用内存 insurance 或故障放行。数据库故障返回通用服务端错误，不继续密码校验或账号写入。
- 配置 `tableCreated: true`、`clearExpiredByTimeout: false`、`blockDuration: 0`、`execEvenly: false`，不用库的额外内存封禁；仅由显式 schema 创建表，拒绝迟滞与默认“过期一小时后、每五分钟清理”的保留策略。
- key 使用 `HMAC-SHA256(RATE_LIMIT_SECRET, 规范化IP)` 并区分注册/登录入口，不保存完整 IP；用标准库或成熟 IP 库规范化 IPv4、IPv6 及 IPv4-mapped IPv6 后再计算 key。HMAC key 仍是可关联标识，不宣称匿名化。
- `RATE_LIMIT_SECRET` 仅用于来源 key，不再配置会话签名密钥；所有实例保持一致，运行期间不静默轮换以清空额度；IP 不写入业务日志。库的时间计算使用应用时钟，实例需要时间同步；会话认证仍使用数据库时钟。
- 清理提案：启动时及每 60 秒使用显式参数化 DELETE 清理已经过期的来源计数和会话。清理失败报告非敏感诊断，不吞错、不延长有效期，也不放行超额请求；故障或停机时无法保证物理删除时效，恢复后清理。可用状态下到期计数通常在一个清理周期内删除，不承诺备份副本同时销毁。

依据：[库说明](https://github.com/animir/node-rate-limiter-flexible)、[所选版本 PostgreSQL 源码](https://unpkg.com/rate-limiter-flexible@11.2.1/lib/RateLimiterPostgres.js)。其 PostgreSQL increment 是原子语句，但在多实例、重启、时钟边界和清理并发情况下仍须 Task 4a 的实测。

### 运行边界提案（待确认，尚未实施）

除已批准的账号锁定、会话、哈希与限流额度外，建议明确采用以下边界，不静默继承：

| 环节 | 建议值 | 超出或失败行为 |
|---|---|---|
| 每个后端进程 pg Pool | 最多 10 条连接，空闲 10 秒回收 | 新请求等待连接；不是总部署并发上限，多实例会累加连接数。 |
| 数据库建连/取连接等待 | 5 秒 | 失败返回通用 500，不自动重试，不发放会话；无可用响应连接则仅记录非敏感诊断。 |
| 身份 SQL 单条执行 | statement_timeout 5 秒 | PostgreSQL 取消语句，所在事务回滚；提交结果不确定时不自动重试，后续查询会话确认。 |
| 等待数据库锁 | lock_timeout 2 秒 | 取消等待，回滚并返回通用 500，不把基础设施故障算作密码错误。 |
| 身份事务空闲 | idle_in_transaction_session_timeout 10 秒 | 数据库终止遗留连接，丢弃失效 client，不复用未知事务状态。 |
| Node 接收请求头/请求体 | 保留本机默认 60 秒/300 秒 | 超时按 Node 行为返回 408 并关闭连接；不是业务处理总超时，不用于未来生成接口超时。 |
| HTTP keep-alive / 请求头大小 | 保留默认 5 秒 / 16 KiB | 空闲连接关闭；请求头过大由 Node 拒绝，不能当作 4 KiB JSON 限制的一部分。 |
| 过期计数及会话清理 | 启动时、每 60 秒 | 失败诊断并等待后续清理；拒绝过期凭证不依赖清理成功。 |

SQL 超时设置只作用于身份数据库访问，未来长时间生成任务不复用这些超时。没有增加应用级自动重试、总业务执行超时或全局请求并发限额；Node 的 socket timeout 和 maxRequestsPerSocket 保持禁用，公开上线前结合实际入口再评估。数据库服务自身边界和反向代理边界需要与实际部署核对，不宣称已完成生产验证。

读到的 pg 默认：max 10、空闲 10 秒、建连默认无超时；本机 Node 只读对象确认上述接收/keep-alive 默认，没有监听端口。statement_timeout 和 lock_timeout 是 PostgreSQL 原生参数，失败语义见 [PostgreSQL client defaults](https://www.postgresql.org/docs/17/runtime-config-client.html)。这些值仍需用户确认，不是已有默认就视为批准。

### 可信代理提案与尚缺部署事实

开发阶段 `trust proxy: false`，只按直接连接 IP 计数，同源 Vite 代理会使浏览器请求共用 Vite 的来源额度，这是本地开发限制，不用于生产真实 IP 识别。生产必须由受信任反向代理提供并覆盖转发头，并将后端限制为仅该代理可访问。

实际生产代理的网络、地址/网段与转发链尚未指定，不能编造可信网段或写 `trust proxy: true`。部署前需要配置明确允许的代理地址/网段；没有可信代理配置则不启用外部凭证接口。开发例外仅在开发模式开放，不声称已解决生产 IP 识别。

### Task 0 当前结论

- 已完成本机版本、顶层包元数据、必要安装脚本及候选 Store 的只读审阅。
- 已批准最小会话服务、rate-limiter-flexible PostgreSQL 固定窗口方案，可推进独立依赖配置。
- 待用户确认：随机凭证长度和 Cookie 编解码库、IP 保留及删除、上述运行边界和实际代理配置。候选依赖使用下表审阅的精确版本，实际安装结果记录于锁文件。
- Task 1a 安装记录：首次无脚本安装共安装 111 个包；冻结锁文件无脚本安装无变更。实际 esbuild 为 `0.28.2`，不是先前审阅的 `0.28.0`，它和 Argon2 的安装脚本均保持禁用，若需执行必须审阅实际版本。
- 后续实现记录：配置、数据库、会话高风险验证、四个认证接口及前端主要链路已完成本地测试与浏览器验证；具体证据见任务清单，未执行构建或正式生产部署。
- 未完成：完整传递依赖和漏洞审阅、生产代理事实、运行参数与定期清理确认。Task 0 仍部分完成，不能将这些上线关卡视为自动通过。

## Source References

- [express-session 官方文档](https://expressjs.com/en/resources/middleware/session.html)：Cookie、持久化 Store、rolling/resave 和生命周期。
- [connect-pg-simple 发布源码](https://unpkg.com/connect-pg-simple@10.0.0/index.js)：Pool 查询与 upsert 行为，不直接采用的依据。
- [rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible)：固定窗口与 PostgreSQL 原子计数，属于 Task 0 待确认依赖。
- [Node 24 HTTP 文档](https://nodejs.org/docs/latest-v24.x/api/http.html)：请求头、请求体接收和 keep-alive 超时。
- [pg Pool 文档](https://node-postgres.com/apis/pool)：连接数与等待/空闲超时。
- [Bun 生命周期脚本文档](https://bun.sh/docs/pm/lifecycle)：初次禁止脚本执行，显式可信名单。
- [node-postgres 事务文档](https://node-postgres.com/features/transactions)：事务必须使用同一个 client，不能用独立 pool.query 混合事务。
- [node-argon2 文档](https://github.com/ranisalt/node-argon2)：Argon2id、密码校验、Node 运行时和本机二进制依赖。
