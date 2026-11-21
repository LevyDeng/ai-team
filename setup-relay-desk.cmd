@echo off
setlocal
chcp 65001 >nul
type "%~dp0docs\install-intro.txt"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-RelayDesk.ps1" %*
set "setup_result=%errorlevel%"
if not "%setup_result%"=="0" type "%~dp0docs\install-error.txt"
if "%setup_result%"=="0" if /I not "%~1"=="-Plan" type "%~dp0docs\install-finished.txt"
pause
exit /b %setup_result%
