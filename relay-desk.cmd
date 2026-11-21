@echo off
setlocal
cd /d "%~dp0"
node desktop\start.cjs
if errorlevel 1 pause
