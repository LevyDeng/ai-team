@echo off
setlocal
title Relay Desk
node "%~dp0desktop\start.cjs"
if errorlevel 1 pause
endlocal
