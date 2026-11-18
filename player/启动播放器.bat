@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if exist "node_modules\electron\dist\electron.exe" goto run
echo [1/2] Installing dependencies, please wait...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
:run
echo [2/2] Starting Nckik's music...
"node_modules\electron\dist\electron.exe" .
goto end
:fail
echo.
echo Install failed. Please check Node.js 18+ and network, then run again.
pause
:end
endlocal
