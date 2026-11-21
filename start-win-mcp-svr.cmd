@echo off
setlocal
title Windows MCP and SSH tunnel
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-WindowsMcp.ps1"
if errorlevel 1 pause
endlocal

