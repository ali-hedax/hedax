@echo off
setlocal
cd /d "%~dp0"
set "HEDAX_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "HEDAX_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not "%HEDAX_NODE%"=="node" if not exist "%HEDAX_NODE%" (
  echo Install Node.js 22 or newer, then run npm install in this folder.
  pause
  exit /b 1
)
if not exist node_modules\playwright (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright" (
    set "NODE_PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules"
  ) else (
    echo Run npm install once in this folder, then start HEDAX again.
    pause
    exit /b 1
  )
)
"%HEDAX_NODE%" companion\start.cjs
if errorlevel 1 (
  pause
  exit /b 1
)
start "HEDAX" http://localhost:5173/
exit /b 0
