@echo off
chcp 65001 >nul
title DeepSeek Harness Dev Mode
cd /d "%~dp0"
node "%~dp0scripts\dev-mode.mjs" --electron %*
if errorlevel 1 echo.
echo Press any key to close this window...
pause >nul
