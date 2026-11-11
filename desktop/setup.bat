@echo off
setlocal
cd /d "%~dp0"
title My Planner Setup

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js is not installed.
  echo     1. Open https://nodejs.org and install the LTS version.
  echo     2. Then double-click setup.bat again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing... this takes 1-2 minutes.
  call npm install
  if errorlevel 1 (
    echo.
    echo [!] npm install failed. Please send a screenshot of this window.
    pause
    exit /b 1
  )
)

rem Electron 45 downloads its development binary on demand, not during npm install.
if not exist "node_modules\electron\dist\electron.exe" (
  call npx --no-install install-electron
  if errorlevel 1 (
    echo [!] Electron download failed. Check your connection and run setup again.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcut.ps1"
if errorlevel 1 (
  echo.
  echo [!] Could not create the shortcut. Please send a screenshot of this window.
  pause
  exit /b 1
)

echo.
echo Done! A calendar icon is now on your Desktop and in the Start menu.
echo Double-click it to run the planner.
echo.
pause
