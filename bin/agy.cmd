@echo off
setlocal
set "RELAY_AGY_ENTRY=%~dp0..\.runtime\workbench\agents\antigravity\agy.exe"
if not exist "%RELAY_AGY_ENTRY%" (
  echo Install Antigravity from Relay Desk agent settings first. 1>&2
  exit /b 1
)
"%RELAY_AGY_ENTRY%" %*
exit /b %errorlevel%
