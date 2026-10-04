@echo off
REM ==========================================================================
REM  XAUUSD Strategy Dashboard - local start-up (analysis + signals only)
REM  1) verify Python  2) create/verify venv + dependencies  3) pre-flight MT5
REM  4) start backend (connects to MT5)  5) open http://127.0.0.1:8765/
REM ==========================================================================
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0"
title XAUUSD Strategy Dashboard

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python was not found.
  echo         Install 64-bit Python 3.10+ from https://www.python.org/downloads/windows/
  echo         and tick "Add python.exe to PATH" during installation.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment in .venv ...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Could not create the virtual environment.
    pause
    exit /b 1
  )
)
set "VPY=.venv\Scripts\python.exe"

"%VPY%" -c "import fastapi, uvicorn, numpy, tzdata, websockets, MetaTrader5" >nul 2>nul
if errorlevel 1 (
  echo Installing / updating Python dependencies ...
  "%VPY%" -m pip install --upgrade pip >nul
  "%VPY%" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo ---- Pre-flight checks ----
"%VPY%" -m xau.doctor
if errorlevel 2 (
  echo [ERROR] Fix the problem above and run start.bat again.
  pause
  exit /b 1
)
echo.
echo ---- Starting dashboard (close this window to stop) ----
"%VPY%" -m xau
pause
