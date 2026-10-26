# Trading by TLUXE - web app + API gateway (Railway service TRADING / "tluxe-web"; build context = this tluxe-trading/ folder).
# It lives at the service root so Railway builds it automatically (no builder / config-path setting needed).
# With DATABENTO_API_KEY set it also runs the Databento bridge (COMEX GC / SI, GLBX.MDP3) inside this container.
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
COPY bridge/databento/requirements.txt ./databento-requirements.txt
RUN pip install --no-cache-dir -r requirements.txt -r databento-requirements.txt
COPY cloud/gateway/tluxe_gateway ./tluxe_gateway
COPY cloud/gateway/entrypoint.py ./entrypoint.py
# Real Databento (official SDK) runs as a supervised child of the gateway when DATABENTO_API_KEY is set.
COPY bridge/databento/run_bridge.py ./databento/run_bridge.py
COPY bridge/databento/tluxe_databento_bridge ./databento/tluxe_databento_bridge
COPY --from=web /web/dist-cloud ./web
# The owner's original HLR dashboard is deliberately NOT copied here.
#
# It is proprietary strategy source (hlr-engine.js is readable, commented code), this repository is
# public, and an image layer is not a private place either. So the copy reaches production only as a
# RAILWAY VOLUME mounted at /app/private/hlr-original - it never enters git and never enters this image.
#
# /app/private is OUTSIDE the static root (/app/web). That is the point: the public static handler
# cannot reach the strategy even in principle. Only the authenticated HLR route reads this path
# (tluxe_gateway/hlr_page.py), and when the mount is absent or empty it answers a clean 404, so a
# build without the volume is harmless rather than broken.
#
# The mount point is created here so a build WITHOUT the volume still has a valid (empty) path.
# NOTE: the chown below runs at BUILD time and cannot decide the ownership of a volume that the
# platform mounts over this path at RUN time - that is the platform's to set. Whether uid 10001
# can read (or an upload can write) the mounted directory must be OBSERVED, not assumed:
# GET /api/hlr/files reports the live owner, mode, readable and writable flags.
RUN mkdir -p /app/private/hlr-original
RUN useradd --create-home --uid 10001 tluxe && chown -R tluxe /app
USER tluxe
EXPOSE 8080
# Liveness only. /readyz (database reachable) and /api/status (the truthful per-component state) are separate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8080'), timeout=4)" || exit 1
STOPSIGNAL SIGTERM
# Runs the gateway (migrations at start-up, then serves) and, with DATABENTO_API_KEY, the Databento bridge beside it.
CMD ["python", "entrypoint.py"]
