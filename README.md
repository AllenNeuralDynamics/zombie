# AIND Data Portal

[Access the Data Portal](https://data.allenneuraldynamics.org)

The data portal is a series of client-side dashboards used to access [cached data and metadata](https://github.com/AllenNeuralDynamics/biodata-cache/) from AIND data assets. Current views include an overview of all [Assets](https://data.allenneuraldynamics.org/assets), individual [Subject](https://data.allenneuraldynamics.org/subject) pages, a tool for tracking [Contributions](https://data.allenneuraldynamics.org/contributions), and a [Project](todo) view.

The data portal also hosts semi-hidden dashboards that are for specific projects or purposes. These include a [Behavior Sessions](https://data.allenneuraldynamics.org/sessions) dashboard used to track which projects and experimenters are running behavioral training at AIND, the [SmartSPIM](https://data.allenneuraldynamics.org/smartspim) dashboard used to view all SmartSPIM platform data assets and easily view them, and a client-side only version of the [QC Portal](https://data.allenneuraldynamics.org/quality_control) which reduces load on the Panel app used for interactive editing.

You can also directly view, download, and pull into Python code the backing cache [tables](https://data.allenneuraldynamics.org/tables.html).

## Philosophy

Data Portal apps are lightweight front-ends that pull all of their data from cached tables. The principle for the site is that while static immutable data assets with standardized metadata are critical for ensuring data meets the FAIR standards, they are often unwieldy for data analysis. The first thing that happens in almost every analysis is that data from a diverse set of incoming assets gets re-formatted into a set of tables. The second thing that happens is that the tables get materialized into figures -- this portal is intended to make this second step intuitive and interactive.

Some of the properties we aim to embed in these portals:

- Intuitive: Portals should be clear about what they are and pull users in without requiring reading, tutorials, or text-based interaction.
- Interactive: Tables should be filterable, timelines should be windowable, figures that share axes should share filters, links should move you between portal views, 3D views should rotate and be clickable, etc...
- Playful: Diverse affordances should create the possibility of discovering things in the data (and metadata) that weren't surfaced intentionally by the developers. 

## Development

Set `AWS_PROFILE` before starting the server so it can read the S3 Parquet files.

In production, nginx serves the static Vite build on port 8000 and forwards
the required S3-list, log-server, and DocDB requests to the Python proxy on
port 3001. DuckDB runs in each browser through DuckDB-WASM. Supervisor manages
nginx and the Python proxy.

### Install and Run

```bash
# Python dependencies for local proxy endpoints
uv sync

# Node dependencies
cd web && npm install
```

```bash
cd web
npm start          # launches the Python proxy and Vite dev server
```

Or run them separately in two terminals:

```bash
# Terminal 1 — Python proxy for S3 listing, log-server, and DocDB requests
cd web && npm run docdb

# Terminal 2 — Vite dev server
cd web && npm run dev
```

Open <http://localhost:5173>.

### Tests

```bash
cd web && npm test
```

## Release channels

The portal ships on two channels. `dev` builds from the `dev` branch on every
push; production builds from `main` on a release cycle.

Every page is listed once in `web/build/routes.js` with a `stability` field.
`stable` pages ship on both channels. `experimental` pages are built and linked
only on the dev channel — the production bundle omits their HTML entirely and
drops them from the shared nav, so they 404 on `data.allenneuraldynamics.org`
until they are promoted.

Mark a page experimental while its data source, URL contract or UI is still
expected to change under users; promote it by changing one field.

```bash
cd web
npm run dev        # dev server — always serves every page
npm run build      # stable bundle (what production ships)
npm run build:dev  # dev-channel bundle, experimental pages included
```

## Production build

A Docker container bundles the static Vite build and Python proxy behind nginx.
DuckDB-WASM remains browser-side and requires no container service.

```bash
docker build -t zombie .
docker run -p 8000:8000 zombie
```

Pass `--build-arg ZOMBIE_EXPERIMENTAL=1` to build the dev-channel image; the
default (off) matches production.

## ZOMBIE?

Because they eat brains!
