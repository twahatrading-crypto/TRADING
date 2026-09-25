@echo off
rem Trading by TLUXE - start the MT5 bridge with THIS project's virtual-env interpreter (absolute path,
rem never a bare "python" from PATH). Exit codes: 2 config, 3 already running, 4 wrong interpreter, 5 port taken.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [TLUXE] %PY% not found. Create it once: py -3.11 -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
  exit /b 4
)
"%PY%" "%HERE%run_bridge.py" %*
exit /b %ERRORLEVEL%
