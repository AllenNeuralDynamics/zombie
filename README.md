# AIND Data Portal

[Access the Data Portal](https://data.allenneuraldynamics.org)

The data portal is a series of client-side dashboards used to access [cached data and metadata](https://github.com/AllenNeuralDynamics/zombie-squirrel/) from AIND data assets. Current views include an overview of all [Assets](https://data.allenneuraldynamics.org/assets), individual [Subject](https://data.allenneuraldynamics.org/subject) pages, a tool for tracking [Contributions](https://data.allenneuraldynamics.org/contributions), and a [Project](todo) view.

The data portal also hosts semi-hidden dashboards that are for specific projects or purposes. These include a [Behavior Sessions](https://data.allenneuraldynamics.org/sessions) dashboard used to track which projects and experimenters are running behavioral training at AIND, the [SmartSPIM](https://data.allenneuraldynamics.org/smartspim) dashboard used to view all SmartSPIM platform data assets and easily view them, and a client-side only version of the [QC Portal](https://data.allenneuraldynamics.org/quality_control) which reduces load on the Panel app used for interactive editing.

## Development

Set `AWS_PROFILE` before starting the server so it can read the S3 Parquet files.

Deployment is done via:

nginx (:8000) → duckdb-server (:3000) + DocDB proxy (:3001) + static SPA. Two managed processes (nginx + duckdb-server + docdb-proxy via supervisord).

### Install and Run

```bash
# Python dependencies (includes duckdb-server)
pip install -e .
# or, if using the project venv:
.venv/bin/pip install -e .

# Node dependencies
cd web && npm install
```

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

## Philosophy

Data Portal apps are lightweight front-ends that pull all of their data from cached tables. The principle for the site is that while static immutable data assets with standardized metadata are critical for ensuring data meets the FAIR standards, they are often unwieldy for data analysis. The first thing that happens in almost every analysis is that data from a diverse set of incoming assets gets re-formatted into a set of tables. The second thing that happens is that the tables get materialized into figures -- this portal is intended to make this second step intuitive and interactive.

Some of the properties we aim to embed in these portals:

- Intuitive: Portals should be clear about what they are and pull users in without requiring reading, tutorials, or text-based interaction.
- Interactive: Tables should be filterable, timelines should be windowable, figures that share axes should share filters, links should move you between portal views, 3D views should rotate and be clickable, etc...
- Playful: Diverse affordances should create the possibility of discovering things in the data (and metadata) that weren't surfaced intentionally by the developers. 
