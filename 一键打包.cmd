@echo off
chcp 65001 >nul
title DeepSeek Harness Package
cd /d "%~dp0"
node "%~dp0scripts\package-desktop.mjs" %*
if errorlevel 1 echo.
echo Press any key to close this window...
pause >nul
