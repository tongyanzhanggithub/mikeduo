@echo off
chcp 65001 >nul
title 觅客舵 - 启动器
cd /d "%~dp0"

rem 与「启动.bat」共用同一个地址 http://localhost:4174/ —— 数据完全互通。
rem 本脚本：若服务未开则后台悄悄开一个（不留黑窗口），再用默认浏览器打开系统。

rem 1) 检查 4174 端口是否已有服务；没有就后台隐藏启动一个静态服务
powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',4174);$c.Close()}catch{Start-Process -WindowStyle Hidden -FilePath python -ArgumentList '-m','http.server','4174' -WorkingDirectory '%~dp0'}" 2>nul

rem 2) 等服务起来
powershell -NoProfile -Command "for($i=0;$i -lt 20;$i++){$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',4174);$c.Close();break}catch{Start-Sleep -Milliseconds 200}}" 2>nul

rem 3) 用默认浏览器打开（和「启动.bat」同一浏览器、同一地址 = 同一份数据）
start "" http://localhost:4174/
