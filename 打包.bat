@echo off
chcp 65001 >nul
title 打包 觅客舵 桌面应用
cd /d "%~dp0"

echo(
echo   ============================================================
echo    一键打包  ·  觅客舵  桌面应用
echo   ------------------------------------------------------------
echo    需要联网，全程约几分钟。完成后会自动打开安装包所在文件夹。
echo   ============================================================
echo(

where node >nul 2>nul
if errorlevel 1 (
  echo   [缺少 Node.js] 请先到 https://nodejs.org 安装 Node.js，再双击本文件。
  echo(
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   [1/2] 安装依赖（npm install）……
  call npm install
  if errorlevel 1 (
    echo(
    echo   依赖安装失败，多半是网络问题。请检查网络后重新双击本文件。
    pause
    exit /b 1
  )
)

echo(
echo   [2/2] 打包（npm run dist）……
call npm run dist
if errorlevel 1 (
  echo(
  echo   打包失败。请把上面的报错整段发给技术支持排查。
  pause
  exit /b 1
)

echo(
echo   ============================================================
echo    打包完成！安装包在 dist-desktop 文件夹里：
echo      MiKeDuo-Setup-v1.0.0.exe
echo    双击它安装，桌面会出现带舵轮图标的「觅客舵」。
echo   ============================================================
start "" "%~dp0dist-desktop"
pause
