@echo off
setlocal
set "RELAY_LOGIN_FOLDER=%~dp0.runtime\workbench\account-login"
if not exist "%RELAY_LOGIN_FOLDER%" mkdir "%RELAY_LOGIN_FOLDER%"
cd /d "%RELAY_LOGIN_FOLDER%"
echo Sign in with the SAME Google account used in Antigravity desktop.
echo Follow Google's official sign-in instructions below. No API key is required.
call "%~dp0bin\agy.cmd" acp --login
pause
