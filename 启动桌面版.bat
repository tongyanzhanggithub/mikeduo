@echo off
rem ============================================================
rem  MiKeDuo desktop app - dev launcher (double-click to run)
rem
rem  ASCII only on purpose. cmd.exe parses .bat with the OEM
rem  codepage, so Chinese text here gets mis-decoded and stray
rem  bytes turn into & < | operators that split the commands.
rem  The other .bat files in this repo already suffer from that
rem  (their Chinese prompts print as garbage). Keep this one ASCII.
rem ============================================================
title MiKeDuo - dev launcher
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [Node.js not found] Install from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   First run: installing dependencies, this takes a few minutes...
  echo   If it stalls on the electron download, press Ctrl+C and use the CN mirror:
  echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  echo     npm install --registry=https://registry.npmmirror.com
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed - most likely a network issue. Try the mirror above.
    pause
    exit /b 1
  )
)

rem Rebuild app.js so edits under src\ take effect on every launch
call node build.mjs
if errorlevel 1 (
  echo.
  echo   Build failed. Send the error above to tech support.
  pause
  exit /b 1
)

rem Launch detached so this console can close without killing the app.
rem Use "." for the app path, NOT "%~dp0": that ends with a backslash and
rem "C:\path\" makes \" an escaped quote, which corrupts the argument.
start "" "node_modules\electron\dist\electron.exe" "."

rem Give it a moment, then close this window (does not close the app)
timeout /t 2 >nul
exit
