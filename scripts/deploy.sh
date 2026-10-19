#!/usr/bin/env bash
# 在生产 WSL 中执行；只用本地已构建的镜像切换 api/web，不改 .env、catalog 或数据卷。
# 用法：deploy.sh <40位提交> <api镜像> <web镜像> [部署目录] [源码目录]
set -Eeuo pipefail
umask 077

revision=${1:-}
api_image=${2:-}
web_image=${3:-}
project=${4:-/mnt/d/infinite-canvas-v2}
source_dir=${5:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
[[ $revision =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
[[ $api_image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ && $web_image =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]] || { echo 'Invalid image reference' >&2; exit 1; }
[[ -f "$source_dir/docker-compose.yml" && -f "$source_dir/server/sql/001-identity.sql" && -f "$source_dir/server/sql/002-identity-rate-limits.sql" ]] || { echo 'Deployment source files are missing' >&2; exit 1; }
cd -- "$project"
[[ -f .env && -f docker-compose.yml && -f server/config/catalog.json ]]

# 阻止手工部署与构建部署同时修改同一栈。
mkdir -p "$HOME/.cache"
exec 9>"$HOME/.cache/infinite-canvas-deploy.lock"
flock -n 9 || { echo 'Another deployment is running' >&2; exit 1; }

# 不继承 Windows wincred 配置：全程只用本地镜像，不访问任何镜像仓库。
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export DOCKER_CONFIG="$work/docker"
mkdir -p "$DOCKER_CONFIG"
printf '{"auths":{}}\n' > "$DOCKER_CONFIG/config.json"

compose() { docker compose -p infinite-canvas-v2 "$@"; }
api_id=$(compose ps -q api)
web_id=$(compose ps -q web)
db_id=$(compose ps -q db)
[[ -n $api_id && -n $web_id && -n $db_id ]] || { echo 'Existing production stack is required' >&2; exit 1; }
previous_api=$(docker inspect -f '{{.Image}}' "$api_id")
previous_web=$(docker inspect -f '{{.Image}}' "$web_id")

# 两个镜像都必须已构建好，且提交标签与本次发布一致。
for image in "$api_image" "$web_image"; do
    actual=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
    [[ $actual == "$revision" ]] || { echo "Image revision does not match commit: $image" >&2; exit 1; }
done

# 只记录旧运行配置和旧镜像引用；数据库快照默认跳过，需要时设 DEPLOY_DB_BACKUP=1。
backup="backups/deploy-$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:7}"
mkdir -p "$backup"
cp docker-compose.yml "$backup/docker-compose.yml"
if [[ -f docker-compose.deploy.yml ]]; then cp docker-compose.deploy.yml "$backup/docker-compose.deploy.yml"; fi
printf '%s\n%s\n' "$previous_api" "$previous_web" > "$backup/previous-images.txt"
if [[ ${DEPLOY_DB_BACKUP:-} == 1 ]]; then
    compose exec -T db pg_dump -U infinite_canvas infinite_canvas > "$backup/db.sql"
fi

write_images() {
    printf 'services:\n  api:\n    image: %s\n  web:\n    image: %s\n' "$1" "$2" > docker-compose.deploy.yml
}
start_apps() {
    compose -f docker-compose.yml -f docker-compose.deploy.yml up -d --no-deps --pull never --force-recreate --wait --wait-timeout 120 api web
}
health() {
    local port
    port=$(compose port web 80)
    port=${port##*:}
    [[ $port =~ ^[0-9]+$ ]] || return 1
    curl --fail --silent --show-error --retry 3 --retry-delay 2 --retry-all-errors --max-time 20 "http://127.0.0.1:$port/api/health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || return 1
    curl --fail --silent --show-error --max-time 20 -o /dev/null "http://127.0.0.1:$port/" || return 1
    curl --fail --silent --show-error --max-time 20 -o /dev/null "http://127.0.0.1:$port/templates/templates.json"
}
rollback() {
    local status=$?
    trap - ERR
    set +e
    echo 'Deployment failed; restoring previous application images' >&2
    cp "$backup/docker-compose.yml" docker-compose.yml
    write_images "$previous_api" "$previous_web"
    if start_apps && health; then
        echo 'Previous application images restored; backup retained' >&2
    else
        echo 'ROLLBACK FAILED: inspect production containers and retained backup' >&2
    fi
    exit "$status"
}
trap rollback ERR

# 仅同步仓库管理的运行文件，绝不递归覆盖部署目录。
cp "$source_dir/docker-compose.yml" docker-compose.yml
mkdir -p server/sql
cp "$source_dir/server/sql/001-identity.sql" "$source_dir/server/sql/002-identity-rate-limits.sql" server/sql/
write_images "$api_image" "$web_image"
compose -f docker-compose.yml -f docker-compose.deploy.yml config --quiet
start_apps
health
trap - ERR
printf 'Deployed commit %s as %s; backup: %s\n' "$revision" "$api_image" "$backup"