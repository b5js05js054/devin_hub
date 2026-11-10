@echo off
chcp 65001 >nul
title DeepSeek Harness Hot Reload
cd /d "%~dp0"
node "%~dp0scripts\dev-mode.mjs" --web %*
if errorlevel 1 echo.
echo Press any key to close this window...
pause >nul
