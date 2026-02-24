# ---------------------------------------------------------------------------
# Stage 1 — Build the Mosaic/Vite frontend
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 node:20-slim AS web-builder

WORKDIR /web

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

# Install Python packages (Panel apps + duckdb-server).
COPY src ./src
COPY pyproject.toml setup.py ./
RUN pip install uv && uv pip install --system . --no-cache

# Copy the built Mosaic frontend (served as static files by nginx).
COPY --from=web-builder /dist ./web/dist

# nginx + supervisord configuration.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/supervisord.conf /etc/supervisor/conf.d/zombie.conf

ENV FOREST_TYPE=s3

# Single externally-exposed port; nginx routes internally to duckdb-server
# (:3000) and Panel (:8001).
EXPOSE 8000

# supervisord starts nginx, duckdb-server, and panel serve.
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/zombie.conf"]
