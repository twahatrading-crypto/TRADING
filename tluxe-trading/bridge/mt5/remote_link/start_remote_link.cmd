@echo off
rem Trading by TLUXE - MT5 remote link (Windows VPS). Read-only market data, outbound WSS to the TLUXE gateway.
rem Run it as a Windows service / scheduled task "At startup" so it survives reboots (see README.md).
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  py -3.11 -m venv "%HERE%.venv" || py -3 -m venv "%HERE%.venv" || (echo Python 3.11+ not found. & exit /b 4)
  "%PY%" -m pip install -r "%HERE%requirements.txt" || exit /b 4
)
"%PY%" "%HERE%link.py" %*
exit /b %ERRORLEVEL%
