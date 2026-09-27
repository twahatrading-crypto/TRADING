@echo off
rem Trading by TLUXE - start the TLUXE news backend (Trading Economics calendar / news, read-only) on 127.0.0.1:8768
rem with THIS folder's virtual-env interpreter. First run creates the venv and installs requirements.
rem Exit codes: 2 config (e.g. TLUXE_NEWS_TOKEN missing), 3 already running, 5 port taken.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [TLUXE News] Creating the virtual environment in %HERE%.venv ...
  py -3.11 -m venv "%HERE%.venv" || py -3 -m venv "%HERE%.venv" || (echo [TLUXE News] Python 3.11+ not found. & exit /b 4)
  "%PY%" -m pip install -r "%HERE%requirements.txt" || exit /b 4
)
if not exist "%HERE%.env" (
  echo [TLUXE News] %HERE%.env not found. Copy .env.example to .env and set TRADING_ECONOMICS_API_KEY and TLUXE_NEWS_TOKEN.
  exit /b 2
)
"%PY%" "%HERE%run_news.py" %*
exit /b %ERRORLEVEL%
