@echo off
rem TLUXE HLR link - starts on the trading PC. Read-only: it only performs GETs against services that
rem are already running here, over loopback. It never starts MT5, IBKR, a collector, a runner or a
rem mailer, and it never accepts an inbound connection.
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo .env is missing. Copy .env.example to .env and fill it in first.
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating .venv ...
  python -m venv .venv || exit /b 1
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip || exit /b 1
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || exit /b 1
)

echo Starting the HLR link (Ctrl+C to stop) ...
".venv\Scripts\python.exe" link.py
