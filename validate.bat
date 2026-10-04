@echo off
REM ==========================================================================
REM  Real-MT5 validation evidence (run on the Windows PC, MT5 open + logged in)
REM    validate.bat               preflight, timezone, ohlc, levels, statemachine, tests, report
REM    validate.bat live          (dashboard running, gold market open) ~12 min watch
REM    validate.bat disconnect    (dashboard running) guided disconnect/reconnect test
REM    validate.bat baseline      export real history + FROZEN baseline backtest
REM    validate.bat report        rebuild docs\real-mt5-validation.md
REM ==========================================================================
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Run start.bat once first - it creates the Python environment.
  pause
  exit /b 1
)
set "VPY=.venv\Scripts\python.exe"
"%VPY%" -c "import pytest, httpx" >nul 2>nul
if errorlevel 1 (
  echo Installing test dependencies ...
  "%VPY%" -m pip install -r requirements-dev.txt
)
set "PHASE=%~1"
if "%PHASE%"=="" set "PHASE=auto"
"%VPY%" -m xau.validate %PHASE% %2 %3 %4
echo.
echo Evidence: docs\validation\   Report: docs\real-mt5-validation.md
pause
