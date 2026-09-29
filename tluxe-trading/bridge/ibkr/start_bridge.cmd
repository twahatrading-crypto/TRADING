@echo off
rem TLUXE IBKR depth bridge (Windows VPS). Uses this folder's virtual environment; settings come from .env here.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Missing .venv - run vps\install-ibkr-bridge.ps1 first.
  exit /b 2
)
".venv\Scripts\python.exe" -m tluxe_ibkr_bridge
