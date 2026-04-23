# ZOMBIE — AIND Data Explorer

Zoomable Observatory for Multi-scale Brain Investigation and Exploration.

[Access the Data Portal](https://data.allenneuraldynamics.org)

> **Warning:** Development mode has no data limits. You can easily make thousands of S3/DocDB requests accidentally.

## Architecture

The app is a **Mosaic/DuckDB-server** single-page application. The browser sends SQL over WebSocket to a local Python DuckDB server that reads Parquet files directly from S3 using your AWS credentials.

Additional tools (asset browser `/assets`, subject viewer `/subject`, contributions editor `/contributions`) are served by the same SPA via client-side routing. No Panel or Bokeh server is required.

**Deployment:** nginx (:8000) → duckdb-server (:3000) + DocDB proxy (:3001) + static SPA. Two managed processes (nginx + duckdb-server + docdb-proxy via supervisord).

## Development

### Prerequisites

```bash
# Python dependencies (includes duckdb-server)
pip install -e .
# or, if using the project venv:
.venv/bin/pip install -e .

# Node dependencies
cd web && npm install
```

### Run (both processes together)

```bash
cd web
npm start          # launches duckdb-server on :3000 AND Vite dev server on :5173
```

Or run them separately in two terminals:

```bash
# Terminal 1 — DuckDB server (reads S3 via AWS_PROFILE)
cd web && npm run server

# Terminal 2 — Vite dev server
cd web && npm run dev
```

Open <http://localhost:5173>.

### AWS credentials

Set `AWS_PROFILE` before starting the server so it can read the S3 Parquet files:

```bash
export AWS_PROFILE=your-profile
cd web && npm start
```

### Tests

```bash
cd web && npm test
```

## Production build

A Docker container bundles the Vite build (static files), the duckdb-server, and the DocDB proxy behind an nginx reverse proxy.

```bash
docker build -t zombie .
docker run -p 8000:8000 zombie
```