无限画布是一款面向图片创作的开源工作台。它把画布编排、AI 图片生成、参考图编辑、对话助手、提示词库和素材沉淀放在同一个界面里，适合用来探索视觉方案并连续迭代图片结果。

> [!CAUTION]
> 项目目前处于开发阶段，不保证历史数据兼容。各种本地存储格式都可能直接调整，欢迎关注后续更新。
>
> 如果你需要稳定维护自己的分支，建议自行 fork 后独立开发。二次开发与 PR 请保留原作者信息和前端页面标识。


## 核心功能

- 无限画布：多画布项目、节点拖拽缩放、连线、小地图、撤销重做、导入导出。
- AI 创作：支持文生图、图生图、参考图编辑、文本问答、音频和视频生成；账号模式由服务端使用用户 Key 代发，模型从上游获取。
- 画布助手：围绕选中节点和上游节点对话、生图，并把结果插回画布。
- 自定义接口调用：可自定义生图 / 视频接口的调用方式，灵活适配各类中转站与自建服务。


### 本地开发

本地默认使用真实账号后端。先按[本地开发文档](docs/content/docs/development/local-development.mdx)配置 PostgreSQL、后端环境和唯一上游，并启动 `server/`，再启动前端：

```bash
git clone git@github.com:basketikun/infinite-canvas.git
cd infinite-canvas
cd web
bun install
bun run dev
```

### Docker 运行

```bash
cp .env.example .env   # 填写数据库密码、加密密钥等，见配置内注释
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

镜像默认在部署机本地构建，不需要镜像仓库凭据；CI 会把同一份代码构建的镜像归档到 GHCR（`.github/workflows/publish-images.yml`），需要时也可以 `docker compose pull` 拉取。线上发布用 `bash scripts/deploy-local.sh`：同步源码到部署机、本地构建后只切换容器。

默认端口 3015，访问 `http://localhost:3015`。登录后在账号配置保存自己的上游 API Key。完整部署、备份与回滚说明见 [Docker 部署](docs/content/docs/overview/docker.mdx)。


## 开源协议
本项目使用 [MIT License](LICENSE)。任何人都可以免费使用、复制、修改、分发、再授权和商业使用本项目，也可以用于闭源产品。
