@echo off
title UCIRP Coimbatore
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   1. Install the LTS version from https://nodejs.org  ^(the download page is opening now^)
  echo   2. Then double-click start.bat again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)
set UCIRP_OPEN=1
echo.
echo   The server has stopped.
pause