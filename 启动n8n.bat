@echo off
chcp 65001 >nul
title 启动 n8n（本地自动化枢纽）
echo(
echo   ============================================================
echo    启动 n8n  ·  本地枢纽（http://localhost:5678）
echo   ------------------------------------------------------------
echo    前提：已装好 Docker Desktop 且鲸鱼图标为绿色(运行中)。
echo   ============================================================
echo(

rem 检查 Docker 是否可用
docker version >nul 2>&1
if errorlevel 1 (
  echo   [未就绪] 没检测到 Docker。请先安装并打开 Docker Desktop（见 n8n自建说明.md 第 1 步），
  echo            等托盘鲸鱼图标变绿后再运行本脚本。
  echo(
  pause
  exit /b 1
)

rem 若 n8n 容器已存在则直接启动；否则创建
docker inspect n8n >nul 2>&1
if not errorlevel 1 (
  echo   n8n 容器已存在，正在启动...
  docker start n8n
) else (
  echo   首次创建 n8n 容器...
  docker volume create n8n_data
  docker run -d --name n8n --restart unless-stopped -p 5678:5678 -v n8n_data:/home/node/.n8n -e GENERIC_TIMEZONE=Asia/Shanghai -e TZ=Asia/Shanghai -e N8N_SECURE_COOKIE=false docker.n8n.io/n8nio/n8n
)

echo(
echo   已启动。几秒后用浏览器打开：http://localhost:5678
echo   首次会让你创建 owner 账号（邮箱+密码，仅存本机）。
echo(
start "" http://localhost:5678/
pause
