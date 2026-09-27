# Trading by TLUXE - TLUXE AI service (read-only assistant, OpenAI Responses API) (Railway service "tluxe-ai"; build context = the tluxe-trading/ folder).
# Secrets come ONLY from Railway variables at runtime - nothing secret is baked into the image.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TLUXE_CONTAINER=1 LOG_FORMAT=json TLUXE_AI_HOST=:: TLUXE_AI_PORT=8767
WORKDIR /app
COPY bridge/ai/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY bridge/ai/run_ai.py ./
COPY bridge/ai/tluxe_ai_bridge ./tluxe_ai_bridge
RUN useradd --create-home --uid 10001 tluxe && chown -R tluxe /app
USER tluxe
EXPOSE 8767
# Liveness only (no auth, no details). Readiness / provider state is judged by the gateway, never by "process up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8767/healthz', timeout=4)" || exit 1
STOPSIGNAL SIGTERM
CMD ["python", "run_ai.py"]
