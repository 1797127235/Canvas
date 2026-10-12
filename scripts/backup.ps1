# 无限画布备份：数据库 + 媒体 + 配置。建议用 Windows 计划任务每日执行，默认保留最近 7 份。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -ProjectDir D:\infinite-canvas-v2
param(
    [string]$ProjectDir = "D:\infinite-canvas-v2",
    [int]$Keep = 7
)

$ErrorActionPreference = "Stop"
# pg_dump 输出是 UTF-8，先对齐控制台解码再捕获，避免中文数据变乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $ProjectDir
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$dest = Join-Path $ProjectDir "backups\$stamp"
New-Item -ItemType Directory -Force $dest | Out-Null

$dbSql = docker compose exec -T db pg_dump -U infinite_canvas infinite_canvas
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
[IO.File]::WriteAllText((Join-Path $dest "db.sql"), ($dbSql -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))

# 媒体目录整体从容器复制，不经过 PowerShell 管道，避免二进制被改写。
docker compose cp api:/app/server/dist/data/media (Join-Path $dest "media")
if ($LASTEXITCODE -ne 0) { throw "media copy failed (exit $LASTEXITCODE)" }
Copy-Item .env (Join-Path $dest ".env")

Get-ChildItem (Join-Path $ProjectDir "backups") -Directory |
    Sort-Object Name -Descending |
    Select-Object -Skip $Keep |
    Remove-Item -Recurse -Force

Write-Host "backup finished: $dest"
