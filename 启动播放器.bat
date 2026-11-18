@echo off
setlocal
set "APP=%~dp0player"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"

if not exist "%EXE%" (
  echo [1/2] Electron runtime not found. Installing dependencies, please wait...
  pushd "%APP%"
  call npm install --no-audit --no-fund
  popd
)

if not exist "%EXE%" (
  echo.
  echo [ERROR] Install failed. Make sure Node.js is installed,
  echo         then run "npm install" inside the player folder.
  echo.
  pause
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE="
echo [2/2] Starting player...
start "" "%EXE%" "%APP%"
endlocal
