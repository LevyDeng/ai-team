@echo off
setlocal
cd /d "%~dp0"
node desktop\start.cjs --legacy
if errorlevel 1 pause
