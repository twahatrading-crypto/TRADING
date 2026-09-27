@echo off
rem Trading by TLUXE - start the TLUXE AI backend (READ-ONLY assistant, OpenAI Responses API) on 127.0.0.1:8767
rem with THIS folder's virtual-env interpreter. First run creates the venv and installs requirements.
rem Exit codes: 2 config (e.g. TLUXE_AI_TOKEN missing), 3 already running, 5 port taken.
setlocal
set "HERE=%~dp0"
set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [TLUXE AI] Creating the virtual environment in %HERE%.venv ...
  py -3.11 -m venv "%HERE%.venv" || py -3 -m venv "%HERE%.venv" || (echo [TLUXE AI] Python 3.11+ not found. & exit /b 4)
  "%PY%" -m pip install -r "%HERE%requirements.txt" || exit /b 4
)
if not exist "%HERE%.env" (
  echo [TLUXE AI] %HERE%.env not found. Copy .env.example to .env and set OPENAI_API_KEY and TLUXE_AI_TOKEN.
  exit /b 2
)
"%PY%" "%HERE%run_ai.py" %*
exit /b %ERRORLEVEL%
