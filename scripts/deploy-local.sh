#!/usr/bin/env bash
# 最快部署：把源码同步到部署机，在部署机上本地构建镜像，再只切换 api/web 容器。不走镜像仓库。
# 用法：bash scripts/deploy-local.sh
# 可选环境变量：DEPLOY_TARGET（默认 miaoda@openai2api.com）、DEPLOY_PORT（默认 2222，置空则不加 -p）、
#   DEPLOY_PROJECT（默认 /mnt/d/infinite-canvas-v2）、DEPLOY_BUILD_DIR（默认 /mnt/d/infinite-canvas-build）、
#   DEPLOY_PUBLIC_URL（默认 http://openai2api.com:3015）、DEPLOY_DB_BACKUP=1（切换前额外做数据库快照）。
set -Eeuo pipefail

target=${DEPLOY_TARGET:-miaoda@openai2api.com}
port=${DEPLOY_PORT-2222}
project=${DEPLOY_PROJECT:-/mnt/d/infinite-canvas-v2}
build_dir=${DEPLOY_BUILD_DIR:-/mnt/d/infinite-canvas-build}
public_url=${DEPLOY_PUBLIC_URL:-http://openai2api.com:3015}
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
revision=$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Run this from the repository checkout' >&2; exit 1; }
tag=local-${revision:0:7}
api_image=infinite-canvas-api:$tag
web_image=infinite-canvas-web:$tag
ssh_opts=(-o BatchMode=yes)
[[ -n $port ]] && ssh_opts+=(-p "$port")
remote() { command ssh "${ssh_opts[@]}" "$target" "$@"; }
git -C "$source_dir" diff --quiet && git -C "$source_dir" diff --cached --quiet || echo '警告：工作区有未提交改动，镜像仍按 HEAD 提交标记' >&2

echo "==> 同步源码到 $target:$build_dir（提交 ${revision:0:7}）"
rsync -az --delete -e "ssh ${ssh_opts[*]}" \
    --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' \
    --exclude '.env' --exclude '.env.*' --exclude 'backups/' --exclude '*.log' \
    --exclude '.vscode/' --exclude '.claude/' \
    "$source_dir/" "$target:$build_dir/"

echo "==> 在部署机并行构建 $api_image / $web_image"
remote bash -s -- "$build_dir" "$revision" "$api_image" "$web_image" <<'REMOTE'
set -Eeuo pipefail
cd -- "$1"
revision=$2; api_image=$3; web_image=$4
docker build --label "org.opencontainers.image.revision=$revision" -f Dockerfile.api -t "$api_image" . > /tmp/canvas-build-api.log 2>&1 & api_pid=$!
docker build --label "org.opencontainers.image.revision=$revision" -f Dockerfile -t "$web_image" . > /tmp/canvas-build-web.log 2>&1 & web_pid=$!
status=0
wait "$api_pid" || status=1
wait "$web_pid" || status=1
if [[ $status -ne 0 ]]; then
    echo '镜像构建失败：' >&2
    tail -n 30 /tmp/canvas-build-api.log /tmp/canvas-build-web.log >&2
    exit 1
fi
echo "镜像就绪：$api_image / $web_image"
REMOTE

echo "==> 切换 api/web 容器"
remote bash -s -- "$revision" "$api_image" "$web_image" "$project" "$build_dir" < "$source_dir/scripts/deploy.sh"

echo "==> 检查公网健康接口"
for _ in 1 2 3 4 5; do
    if curl --fail --silent --max-time 20 "$public_url/api/health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
        echo "部署完成：$public_url（$tag）"
        exit 0
    fi
    sleep 3
done
echo '公网健康检查失败：请检查容器状态和 APP_ORIGIN 配置' >&2
exit 1