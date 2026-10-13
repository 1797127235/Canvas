# 前端多阶段构建：Vite 产物由 nginx 托管，/api 反代到同栈 api 服务。
FROM oven/bun:1.3.14 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY web ./
RUN bun run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html

EXPOSE 80
