# Trading by TLUXE - web app + API gateway (Railway service "tluxe-web"; build context = the tluxe-trading/ folder).
# Stage 1 builds the CLOUD web bundle (same-origin gateway URLs only) and fails the build if the bundle contains a
# localhost endpoint, an API key or any credential (scripts/scan-bundle.cjs). Stage 2 serves it with the gateway.
# Secrets come ONLY from Railway variables at runtime - nothing secret is baked into either stage.
FROM node:22-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build:cloud

FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TLUXE_ENV=production LOG_FORMAT=json TLUXE_GATEWAY_HOST=0.0.0.0 PORT=8080 TLUXE_STATIC_DIR=/app/web
WORKDIR /app
COPY cloud/gateway/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY cloud/gateway/tluxe_gateway ./tluxe_gateway
COPY --from=web /web/dist-cloud ./web
RUN useradd --create-home --uid 10001 tluxe && chown -R tluxe /app
USER tluxe
EXPOSE 8080
# Liveness only. /readyz (database reachable) and /api/status (the truthful per-component state) are separate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)" || exit 1
STOPSIGNAL SIGTERM
# Applies pending database migrations (advisory-locked, checksummed) at start-up, then serves.
CMD ["python", "-m", "tluxe_gateway"]
