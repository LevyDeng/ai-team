@echo off
setlocal
title ai-team
node "%~dp0desktop\start.cjs"
if errorlevel 1 pause
endlocal
