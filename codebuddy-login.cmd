@echo off
setlocal
set "RELAY_LOGIN_FOLDER=%~dp0.runtime\workbench\account-login"
if not exist "%RELAY_LOGIN_FOLDER%" mkdir "%RELAY_LOGIN_FOLDER%"
cd /d "%RELAY_LOGIN_FOLDER%"
echo Sign in with the SAME account and region used in WorkBuddy.
echo If the login screen is not shown, enter /login in the official CLI.
echo For the international desktop, choose International Site.
echo No API key is required for this account login.
call "%~dp0bin\codebuddy.cmd"
if errorlevel 1 pause
