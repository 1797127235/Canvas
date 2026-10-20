# 无限画布文档索引

所有链接都是仓库内真实文件的相对路径。项目没有独立文档站，`docs/content/docs/` 下的 `.mdx` 就是正文，统一使用简体中文。

## 项目介绍

- [快速开始](content/docs/overview/quick-start.mdx)
- [功能介绍](content/docs/overview/features.mdx)
- [Docker 部署](content/docs/overview/docker.mdx)
- [第三方提示词来源](content/docs/overview/third-party-prompt-repositories.mdx)

## 操作手册

- [画布节点操作手册](content/docs/canvas/canvas-node-manual.mdx)
- [画布快捷键](content/docs/canvas/canvas-shortcuts.mdx)

## 规格

- [能力地图](specs/capability-map.md)：本地多用户范围、账号 Key、上游模型发现，以及工作区、媒体、生成、历史的边界。
- [身份规格](specs/identity.md)：已批准的需求、契约和本地验收证据。
- [身份技术计划](specs/identity-plan.md)：已批准的技术方案、阶段性开放策略和遗留生产决策。
- [身份任务清单](specs/identity-todo.md)：此前的身份验收结论和多用户实现追踪；新改动需重新验收，不继承早先测试结果。
- [上游目录规格](specs/catalog.md)：账号上游模型发现、四类生成协议、账号历史和本地开发契约。\n- [网关与提供商边界](specs/gateway-provider-boundaries.md)：账号连接、provider 模块、最小执行绑定、规格源和分阶段迁移边界。
- [模板库规格](specs/template-library.md)：提示词库改名为模板库入口那一版的阶段性规格；完整工作流模板库在其后落地。
- [生成请求内联素材（问题）](specs/generation-media-payload.md)：账号模式把参考素材以 base64 内联进生成请求，实测单次请求体约 29.5MB；含实测数据、影响和根因。
- [视频网关协议不一致（问题）](specs/video-gateway-protocol.md)：网关兼容层按旧中转字段发往 `/v1/videos`，与 Codex2API 的 OpenAI Videos 字段不一致；H3 被拒，Seedance 参考图被丢弃。
- [生成请求内联素材（初步调研）](specs/generation-media-payload-investigation.md)：上述问题的代码考古、现状梳理、可复用能力、方案对比和待确认项；未改动代码。
- [服务端与网页端数据流向审计](specs/media-data-flow-audit.md)：根因是项目没有资源抽象，由此产生字节多份、引用多份、搬运重复实现、无回收等后果；含代码定位与处理顺序。
- [资源身份单点化](specs/resource-identity.md)：上述问题的实现方案与落地结果；生成上行/下行改传 `remote:<uuid>`、视频流式落盘、引用表与回收、请求体分档上限。
- [画布 Agent 接入](specs/agent-copilotkit.md)：CopilotKit/AG-UI 的目标架构与文件组织；只装前端 SDK、服务端按契约自实现两个路由以保持 `ai` 单份依赖；工具在浏览器执行的边界。
- [助手图片附件](specs/agent-attachments.md)：输入框上传图片、消息只存 `remote:<uuid>`、服务端按账号解析最近 4 张交给模型，以及单张/总量限制。

## 开发与数据

- [本地开发](content/docs/development/local-development.mdx)
- [线上部署](content/docs/development/deployment.mdx)：生产地址、部署机、发布流程与注意事项。
- [画布数据结构](content/docs/development/canvas-data-structure.mdx)

## 支持与安全

- [漏洞提交](content/docs/support/security.mdx)

## 项目进度

- [更新日志](../CHANGELOG.md)
- [待测试](content/docs/progress/pending-test.mdx)
- [TODO](content/docs/progress/todo.mdx)

## 说明

- 当前开发环境就是实际运行环境：画布、素材和生成历史按账号存 PostgreSQL，媒体存服务端磁盘或可选 MinIO；旧浏览器本地模式只在显式 `VITE_AUTH_BYPASS=true` 时开放。
- 账号使用一把 API Key，服务端加密保存并代发四类生成；模型从 `server/config/catalog.json` 配置的唯一上游发现。