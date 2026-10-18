# Capability Map: 多用户无限画布

状态：已批准。模块规格按构建顺序分别编写。

## 前提假设

1. 注册使用邮箱和密码，密码长度为 8～128 个字符，仅允许可打印 ASCII 字符（U+0021～U+007E），不允许中文和空格，不自动去除或截断输入。登录状态放在 HttpOnly Cookie 中，登录会话固定有效期为 7 天，关闭浏览器后仍有效，到期需重新登录，不自动续期。这一阶段不做邮箱验证和找回密码。
2. 每个用户只保存一个 API Key。模型目录只提供上游地址和模型，不保存 Key；生成请求统一使用这把账号 Key。
3. 服务端固定唯一上游地址，模型列表使用当前账号 Key 请求上游 `/models`；配置只提供能力与名称映射，没有管理后台。
4. 账号工作区和生成历史使用 PostgreSQL，媒体本地开发默认保存服务端磁盘，也可配置 MinIO。
5. 不迁移现有 IndexedDB 数据。Agent 交互由后续 CopilotKit/AG-UI 接入负责。
6. 画布自动保存间隔为 400 毫秒，保存时携带版本号。
7. 开发阶段不设单文件、账号总量或画布数量限额。
8. 已确认登录锁定规则：同一账号连续输错密码 5 次后锁定 15 分钟，成功登录清零失败次数；锁定期间即使密码正确也不能登录，重复尝试不延长锁定时间，到期自动解除，已有登录会话不受影响。
9. 注册成功后立即建立 7 天会话；从游客模板或示例发起注册时，登录后返回原入口，不自动执行生成、上传等操作。
10. 同一账号允许多设备同时登录，每次登录建立独立的 7 天会话；退出登录只撤销当前会话，同一浏览器共用该会话的标签页也退出，不影响其他设备。本期不做设备管理或一键退出所有设备。
11. 注册和登录时去除邮箱首尾空格并统一转为小写，大小写不同的同一邮箱视为同一账号，不允许重复注册；不合并邮箱中的点号或 `+标签` 别名。
12. 多用户业务后端使用 Node.js、TypeScript、Express 和 PostgreSQL，源码放在独立的 `server/` 目录；Agent 通过后续 CopilotKit/AG-UI Runtime 接入，不再依赖本地 Agent。
13. 浏览器通过同源入口访问前端页面和 `/api/` 接口；开发环境由 Vite 将 `/api` 代理到后端。前后端进程可独立部署，本期不支持跨站点前端接入。

## 模块规格索引

- `identity`：[identity.md](./identity.md)，已批准；[技术计划](./identity-plan.md) 已批准；[任务清单](./identity-todo.md) 已批准；identity 本地注册、登录、会话、限流及入口边界已实现；后端 54/54、前端 14/14 测试、两端类型检查及独立浏览器主要流程通过。用户已确认注册、登录、锁定和双标签页退出主流程通过。本地默认开启真实多用户模式，旧本地工作区仅显式 `VITE_AUTH_BYPASS=true` 时开放；生产运行参数/代理/定期清理不属于本轮开发验收。
- `catalog`：[catalog.md](./catalog.md) 已按本地开发标准接入账号上游模型发现，目录不保存 Key、不绑定特定模型，失败不回退本地渠道。
- `credentials`、`media`、`workspace`、`generation` 已补齐账号 Key 加密、四类服务端生成、账号历史、工作区串行保存和换号隔离、媒体 Range 读取及 ZIP 导入重新归属；本轮专项后端 14/14、前端 5/5、两端类型检查、真实数据库双账号隔离、独立浏览器主流程以及真实文本/图片/视频生成与重启恢复通过；未逐项验证的参数、断网/冲突交互与 ZIP 互导保留在 Pending Tests。

## 模块

| Module id | Responsibility | Depends on |
|---|---|---|
| identity | 注册、登录、退出、会话 | — |
| catalog | 服务端上游地址、协议、模型目录和调用适配 | — |
| credentials | 当前用户 API Key 的加密保存、掩码显示、更换和清除 | identity |
| media | 账号媒体上传、磁盘/对象存储、鉴权读取和播放 | identity |
| workspace | 按用户保存画布、素材和生成记录，并做版本校验 | identity、media |
| generation | 校验模型后，用服务端地址和当前用户的 Key 代发请求，并保存生成结果 | identity、catalog、credentials、media、workspace |

Build order: identity、catalog → credentials、media → workspace → generation

## 边界

- 游客可浏览现有内置模板和只读示例画布，允许缩放、平移和媒体预览，不开放游客本地编辑；创建、克隆、编辑、保存、上传、生成和配置 API Key 等真实操作需跳转登录。个人画布、素材和生成记录必须登录后访问，服务端同样校验权限，不向游客返回私人数据。此入口不扩展为本期之外的公开模板库。
- identity 提供当前用户 ID。其他模块只按该 ID 隔离数据，不解析密码或 Cookie。
- catalog 用 credentials 提供的当前账号 Key 获取上游模型，公开结果只含 ID、显示名称和能力。
- credentials 只管理当前用户的一个 API Key，不保存 Base URL 或模型名称。generation 读取这把 Key，目录里的 Key 不再有效。
- media 管理账号对象和读取权限，不设业务容量额度。workspace 和生成历史保存媒体引用。
- generation 校验模型并代发请求，结果写入 media 和 workspace。画布编辑与自动保存属于 workspace。
- Agent 交互层通过后续 CopilotKit/AG-UI Runtime 接入，画布与生成业务仍由 workspace、media、generation 模块负责。

## 本期不做

团队、分享链接、忘记密码、管理后台界面、跨设备实时协同编辑、IndexedDB 数据迁移。
