@echo off
REM Usage: backtest.bat 2024-01-01 2024-12-31 [extra args, e.g. --entry-mode confirmation]
setlocal
set "PYTHONUTF8=1"
cd /d "%~dp0"
if "%~2"=="" (
  echo Usage: backtest.bat FROM_DATE TO_DATE [--entry-mode limit_ce^|limit_edge^|confirmation] [--include-untaken]
  echo Example: backtest.bat 2024-01-01 2024-12-31
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Run start.bat once first to create the Python environment.
  exit /b 1
)
".venv\Scripts\python.exe" -m xau.backtest --from %1 --to %2 %3 %4 %5 %6
pause
