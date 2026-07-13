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

# Install Python runtime dependencies (duckdb-server + docdb proxy).
# The zombie Python package is no longer needed at runtime; all apps are
# served as static files by the Mosaic SPA.
RUN pip install uv && uv pip install --system \
    "duckdb-server>=0.21.1" \
    "aind-data-access-api[docdb]" \
    "pymysql" \
    --no-cache

# Pre-install DuckDB extensions at build time so they are available without
# outbound network access when the server starts (INSTALL at runtime hangs or
# fails if extensions.duckdb.org is unreachable from inside the container).
RUN python -c "import duckdb; con = duckdb.connect(); con.execute('INSTALL httpfs; LOAD httpfs;'); con.close()"

# Copy the built Mosaic frontend (served as static files by nginx).
COPY --from=web-builder /dist ./web/dist

# Copy the DocDB proxy script (runs server-side to reach the internal AIND API).
COPY web/docdb_proxy.py ./web/docdb_proxy.py

# nginx + supervisord configuration.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/supervisord.conf /etc/supervisor/conf.d/zombie.conf

ENV FOREST_TYPE=s3

# Single externally-exposed port; nginx routes internally to duckdb-server
# (:3000) and the DocDB proxy (:3001).
EXPOSE 8000

# supervisord starts nginx, duckdb-server, and the docdb proxy.
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/zombie.conf"]
