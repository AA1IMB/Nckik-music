@echo off
setlocal
cd /d "%~dp0"
set "EXE=player\node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo [1/2] Electron runtime not found. Installing dependencies, please wait...
  pushd player
  call npm ci --no-audit --no-fund
  popd
)

if not exist "%EXE%" (
  echo.
  echo [ERROR] Install failed. Check Node.js 18+ and network, then run again.
  echo.
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
set "TMP=%CD%\.tmp"
set "TEMP=%CD%\.tmp"
if not exist "%TMP%" mkdir "%TMP%"

echo [2/2] Starting Nckik music...
start "" "%EXE%" --no-sandbox "player"

rem Give it a moment, then check the process really came up.
rem Without this, a failed start only flashes a black window.
ping -n 5 127.0.0.1 >nul
tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 goto done

echo.
echo [ERROR] Nckik music did not start.
echo.
echo The app writes its own error log here:
echo   %APPDATA%\NckiksMusic\crash.log
echo.
if exist "%APPDATA%\NckiksMusic\crash.log" (
  echo --- last lines of crash.log ---
  powershell -NoProfile -Command "Get-Content -LiteralPath $env:APPDATA\NckiksMusic\crash.log -Tail 8"
  echo -------------------------------
  echo.
)
echo If the log is empty, run this in a terminal to see Chromium output:
echo   cd /d "%CD%\player"
echo   node_modules\electron\dist\electron.exe --no-sandbox .
echo.
pause
exit /b 1

:done
endlocal
