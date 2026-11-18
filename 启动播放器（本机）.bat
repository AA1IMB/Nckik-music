@echo off
rem ---------------------------------------------------------------
rem  Launch Nckik's music on THIS machine (double-click friendly).
rem
rem  Why not player\启动播放器.bat here:
rem    - Chromium's sandbox cannot initialise in this session, so
rem      electron.exe dies with 0x80000003 (STATUS_BREAKPOINT)
rem      before any window appears -> --no-sandbox is required.
rem    - ELECTRON_RUN_AS_NODE is set machine-wide and would turn
rem      Electron into plain Node (no window at all).
rem    - %TEMP% is restricted; TMP/TEMP are redirected into .tmp
rem
rem  The flag only disables Chromium's process sandbox; the app's
rem  own IPC boundary (contextIsolation + contextBridge) is intact.
rem ---------------------------------------------------------------
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

echo [2/2] Starting Nckik's music...
start "" "%EXE%" --no-sandbox "player"

rem Wait a moment, then verify the process really came up. Without this
rem check a failed start just flashes a black window and nobody can tell why.
timeout /t 4 /nobreak >nul
tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 goto done

echo.
echo [ERROR] Nckik's music did not start.
echo.
echo The app writes its own error log here:
echo   %APPDATA%\NckiksMusic\crash.log
echo.
if exist "%APPDATA%\NckiksMusic\crash.log" (
  echo --- last lines of crash.log ---
  powershell -NoProfile -Command "Get-Content -LiteralPath \"$env:APPDATA\NckiksMusic\crash.log\" -Tail 8"
  echo -------------------------------
  echo.
)
echo If the log is empty, run this in a terminal to see Chromium's own output:
echo   cd /d "%CD%\player"
echo   node_modules\electron\dist\electron.exe --no-sandbox .
echo.
pause
exit /b 1

:done
endlocal
