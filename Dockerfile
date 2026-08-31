# ---------------------------------------------------------------------------
# Stage 1 — Build the Mosaic/Vite frontend
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 node:20-slim AS web-builder

WORKDIR /web

ARG VITE_QC_SPA_CLIENT_ID=a625f758-ee73-4fc0-8a4b-b7467f33d68c
ARG VITE_QC_SPA_TENANT_ID=32669cd6-737f-4b39-8bdd-d6951120d3fc
ARG VITE_QC_SPA_EDITOR_ENABLED=true
ENV VITE_QC_SPA_CLIENT_ID=${VITE_QC_SPA_CLIENT_ID} \
    VITE_QC_SPA_TENANT_ID=${VITE_QC_SPA_TENANT_ID} \
    VITE_QC_SPA_EDITOR_ENABLED=${VITE_QC_SPA_EDITOR_ENABLED}

# Install dependencies first for better layer caching.
COPY web/package.json web/package-lock.json ./
RUN npm ci

# Copy the rest of the web source and build.
# vite.config.js sets outDir: '../dist', so the bundle lands at /dist.
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Python runtime with nginx + supervisord
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 python:3.13-slim

WORKDIR /app

# Install nginx and supervisor (multi-process manager).
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx supervisor libuv1 \
    && rm -rf /var/lib/apt/lists/*

# Install Python runtime dependencies for the HTTP proxy.
# The zombie Python package is no longer needed at runtime; all apps are
# served as static files by the Mosaic SPA.
RUN pip install uv && uv pip install --system \
    "aind-data-access-api[docdb]" \
    "pymysql" \
    --no-cache

# Copy the built Mosaic frontend (served as static files by nginx).
COPY --from=web-builder /dist ./web/dist

# Copy the DocDB proxy script (runs server-side to reach the internal AIND API).
COPY web/docdb_proxy.py ./web/docdb_proxy.py

# nginx + supervisord configuration.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/html-cache.conf /etc/nginx/snippets/html-cache.conf
COPY deploy/supervisord.conf /etc/supervisor/conf.d/zombie.conf

ENV FOREST_TYPE=s3

# Single externally-exposed port; nginx serves static files and routes proxy
# requests internally to the Python service on :3001.
EXPOSE 8000

# supervisord starts nginx and the Python proxy.
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/zombie.conf"]
