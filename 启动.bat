@echo off
chcp 65001 >nul
title 觅客舵 - 本地服务（请勿关闭本窗口）
cd /d "%~dp0"

echo(
echo   ============================================================
echo    觅客舵  ·  本地服务
echo   ------------------------------------------------------------
echo    浏览器会在几秒后自动打开 http://localhost:4174/
echo    使用期间请【保持本窗口开着】；关闭本窗口 = 关闭系统。
echo    端口固定 4174（数据按地址存，换端口会看不到数据）。
echo   ============================================================
echo(

rem 先派一个后台小助手：等 2 秒服务起来后再开浏览器（避免开太早打不开）
start "" /min cmd /c "timeout /t 2 >nul ^& start "" http://localhost:4174/"

rem 前台运行静态服务器：优先 python，其次 py 启动器
python -m http.server 4174
if errorlevel 1 py -3 -m http.server 4174
if errorlevel 1 (
  echo(
  echo   [启动失败] 没找到 Python。请到微软商店安装 Python 3，或改用其它静态服务器指向本目录（端口必须用 4174）。
  echo(
)
pause
