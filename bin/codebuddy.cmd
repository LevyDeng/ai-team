@echo off
setlocal
set "RELAY_CODEBUDDY_ENTRY=%~dp0..\.runtime\workbench\agents\codebuddy\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy"
if not exist "%RELAY_CODEBUDDY_ENTRY%" (
  echo CodeBuddy CLI is not installed. Use Install-CodeBuddyCommand.ps1 first. 1>&2
  exit /b 1
)
node.exe "%RELAY_CODEBUDDY_ENTRY%" %*
exit /b %errorlevel%
