@echo off
setlocal
title Configure password-free SSH
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Ssh.ps1"
pause
endlocal

