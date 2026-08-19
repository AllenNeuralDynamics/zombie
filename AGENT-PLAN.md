# Agent-Backed Analysis Sidebar — Plan

Goal: on `/view` (`web/view.html` → `src/view-entry.js` → `combined/view.js`), an
openable sidebar where a user iterates with an agent to build a small Python
analysis of the **currently selected asset**, then presses **Package** to freeze
it into a re-runnable `analyze(asset_name) -> outputs` recipe (figures, CSV,
JSON) that anyone can re-run from the same sidebar on any asset.

## 0. Ground truth (verified in repos, not assumed)

| Fact | Evidence |
|---|---|
| Zombie is client-only; no server, no secrets | `AGENTS.md`, `web/docdb_proxy.py` is a thin proxy |
| A chat widget already talks to the portal | `web/src/lib/chat-widget.js` → `POST https://metadata-portal.allenneuraldynamics.org/chat`, single-shot JSON, `{message, history}` → `{response}` |
| Portal has the credentialed agent loop | `aind_metadata_viz/chat/agent.py:run_agent` — Bedrock Converse, `MAX_ITERATIONS=12`, `MAX_TOOL_CALLS=24`, per-tool timeout, `ToolCallRecord` audit |
| Tools come from the MCP package, allow-listed | `chat/tools.py` imports `aind_data_mcp.data_access_server`, then `mcp.disable(DISABLED_TOOLS)` (both NWB tools disabled: hard-coded `/data` path, arbitrary-S3-link probing) |
| MCP is also mounted over HTTP with origin+rate guards | `chat/mcp_app.py` (`/mcp`, `_MCPSecurityMiddleware`) |
| Existing MCP tools are all *fixed-shape queries* | `cache_tools.py` (~25 `get_*` tools), `query_tools.py` (DocDB), no code execution |
| MCP already ships prompt "skills" as resources | `aind_data_mcp/resources/{aind_api_prompt,cache_api_prompt,load_nwbfile}.txt` |
| Portal has ORCID auth + sessions | `aind_metadata_viz/auth/` |
| `/view` already tracks the asset in the URL | `combined/view.js:39` `params.get('asset')`, `:72` writes it back |
| Precedent for rendering S3 artifacts in zombie | `src/analysis_framework/view.js` — DocDB `analysis` records + `/s3-list` proxy → inline PNGs |

Consequence: **do not build a new agent service.** Extend the portal's agent
loop and put the new capabilities in `aind-data-mcp` as tools + skills.

## 1. Where the Python runs — decision

**Server-side, in a dedicated sandbox process, reached through the MCP.**
Not Pyodide.

Why not in-browser Pyodide:
- The interesting inputs are private/large S3 objects: `platform_swdb_*` parquet
  partitions and ~3.7 GB HDF5 `.nwb`. Browser wheels for `h5py`/`pynwb` are not
  a supported path, and range-reading multi-GB HDF5 over HTTPS in a tab is not
  a real analysis substrate.
- Credentials must stay server-side (the whole reason `/chat` exists).
- A packaged recipe must be re-runnable *headlessly* (batch over 200 assets,
  scheduled refresh). If iteration happens in Pyodide and packaging targets the
  server, you maintain two runtimes with different results. One runtime only.

What stays in the browser: everything already there — DuckDB-WASM over the
cache parquet for the *page's* plots, and rendering of artifacts the sandbox
returns. If a future recipe is provably pure-cache-table SQL, it can be
compiled to a browser DuckDB query; that is an optimisation, not the model.

Sandbox shape (in order of preference; ship B, design for C):
- **A — in-portal subprocess.** Fast to ship, worst isolation: shares the
  portal task role. Only acceptable behind ORCID auth for authors.
- **B — sibling container, no AWS creds of its own beyond a scoped read-only
  role** (`aind-analysis-sandbox-ro`: `s3:GetObject` on the public/cache
  buckets, `s3:PutObject` only on `…/analysis-artifacts/<run_id>/`). Launched
  by `deploy/`-style supervisord next to the portal, spoken to over localhost
  HTTP. Per-run: fresh tmpfs cwd, `python -I`, `RLIMIT_AS`/`RLIMIT_CPU`/
  `RLIMIT_NOFILE`, wall-clock kill, egress allow-list (S3 + DocDB only),
  no inherited env. **This is the target for v1.**
- **C — Code Ocean / Fargate one-shot task** for heavy recipes (full NWB,
  minutes of CPU). Same `analyze()` contract, different executor; the recipe
  declares `runtime: "sandbox" | "batch"`.

## 2. Components and files

### 2.1 `aind-data-mcp` — new `sandbox_tools.py` + skills

New tools (registered on the shared `mcp` instance, so both `/chat` and `/mcp`
see them):

```
run_python(code: str, session: str, asset_name: str | None) -> RunResult
    Executes code in the session workspace. Returns
    {stdout, stderr, error, duration_s, artifacts: [{name, kind, bytes|url, mime}]}
    Injected preamble only: `ASSET_NAME`, `ctx` (see 2.3). No implicit imports.
list_session_files(session) / read_session_file(session, name, max_bytes)
open_asset(asset_name) -> manifest      # resolved S3 prefix, files, sizes, kind
load_asset_table(asset_name, table)     # cache parquet partition -> DataFrame in session
```

Deliberately **not** added: any tool taking a free-form S3 URL. That is exactly
the hole `DISABLED_TOOLS` closes; `open_asset` resolves names → paths
server-side instead.

New skills as `resources/*.txt` (same mechanism as `cache_api_prompt.txt`),
surfaced to the model and injected into the system prompt when the analysis
agent starts:
- `analysis_recipe_contract.txt` — the `analyze()` signature + output rules.
- `analysis_plotting.txt` — matplotlib-only, `Agg`, save via `ctx.figure()`,
  no `plt.show()`, no seaborn styling drift.
- `asset_data_map.txt` — which asset kinds have which readable tables
  (cache parquet vs `platform_swdb_*` vs raw NWB), with worked examples.
- `nwb_reading.txt` — replaces the disabled NWB tools: how to lazily read a
  remote NWB inside the sandbox with a byte budget.

Tests: `tests/test_sandbox_tools.py` — timeout kill, memory cap, artifact
capture, network denial, no-creds assertion, `open_asset` rejects paths.

### 2.2 `aind-metadata-viz` — analysis endpoints + streaming loop

- `chat/agent.py`: refactor `run_agent` into `async def stream_agent(...)`
  yielding events (`{type: "text"|"tool_start"|"tool_end"|"artifact"|"done"}`);
  keep `run_agent` as a thin collector so `/chat` and `test_chat.py` are
  untouched. This is required — today tool activity is only visible after the
  whole turn, and an analysis turn runs code for tens of seconds.
- `analysis/handlers.py` (new router, mirrors `chat/handlers.py`: origin check
  via `chat/security.py`, `RateLimiter`, `append_chat_log` audit):
  - `POST /analysis/chat` (SSE) — `{message, history, session, asset_name}`.
  - `GET  /analysis/artifact/{session}/{name}` — bytes, `Cache-Control: private`.
  - `POST /analysis/package` — **ORCID-required**. `{session}` → agent is asked
    to emit the frozen module, server validates (2.4) and stores it.
  - `POST /analysis/run` — `{recipe_id, version, asset_name}` → executes a
    stored recipe. Anonymous-allowed, rate-limited. This is the endpoint the
    "re-run" button and any batch job use.
  - `GET  /analysis/recipes` — registry listing.
- `analysis/store.py` — recipe persistence, modelled on
  `contributions/store.py`: S3 `allen-data-views/analysis-recipes/<id>/<version>/`
  holding `recipe.py`, `recipe.json` (name, author ORCID, asset-kind
  applicability, declared outputs, code sha256, runtime, created_at), plus a
  rolled-up `registry.json`. Zombie can *read* the registry with the existing
  `/s3-list` proxy pattern; all writes go through the authed endpoint.
- Caps: code ≤ 64 KB, wall clock ≤ 120 s (sandbox) / async (batch), artifacts
  ≤ 25 MB per run, ≤ 20 artifacts, sessions expire in 24 h, artifacts in 7 d.

### 2.3 Recipe contract

```python
# recipe.py — what "Package" produces. Single module, no side effects at import.
OUTPUTS = [
    {"name": "trial_rates.png", "kind": "figure", "title": "Response rate by block"},
    {"name": "trials.csv",      "kind": "table"},
    {"name": "summary.json",    "kind": "metadata"},
]

def analyze(asset_name: str, ctx) -> dict:
    """Return {output_name: path_or_object}. Must be pure w.r.t. asset_name."""
```

`ctx` (provided by the sandbox, identical during iteration and packaged runs):
`ctx.asset` (manifest from `open_asset`), `ctx.table(name)` → DataFrame,
`ctx.figure(name)` → context manager returning a matplotlib Figure that is
saved+registered on exit, `ctx.write_csv(name, df)`, `ctx.write_json(name, obj)`,
`ctx.log(msg)`, `ctx.budget` (remaining seconds/bytes). Everything else is
plain `pandas`/`numpy`/`matplotlib`/`pyarrow`/`duckdb`/`h5py`/`pynwb`.

Iteration uses the *same* `ctx`, so packaging is a refactor, not a port.

### 2.4 Packaging = validate, don't trust

`POST /analysis/package` does, server-side:
1. Ask the model (one bounded turn, `analysis_recipe_contract.txt` in system)
   to emit the module from the session transcript.
2. `ast.parse` → reject non-module-level statements outside defs, reject
   `OUTPUTS` mismatch, reject `open()` outside `ctx`, reject `os.environ`,
   `boto3.client` with explicit creds, `subprocess`, `socket`.
3. Execute on the originating asset — outputs must match `OUTPUTS` exactly.
4. Execute on **2 sibling assets** of the same platform/kind (chosen via
   `get_asset_basics`) — a recipe that only works on one asset is not a recipe.
   Failures are reported back to the user as a re-runnable diagnosis, not
   silently stored.
5. Store on success; version bumps are immutable.

### 2.5 Zombie — the sidebar

- New `web/src/analysis/` (Preact + `htm/preact` per `AGENTS.md`: this has
  transcript, streaming, artifacts, session, recipe list, run state — well past
  the ~3 state-variable line).
  - `panel.js` — `mountAnalysisPanel({ getAsset, onAssetChange })`, returns
    `{ destroy }`. Off-canvas right drawer, collapsed by default, state in
    `localStorage` (`zombie-analysis-panel`), `?analysis=<recipe_id>` deep-link.
  - `stream.js` — SSE client for `/analysis/chat` with `AbortController`;
    aborts on asset change (`AGENTS.md` abort pattern).
  - `transcript.js`, `code-block.js` (collapsed code + stdout/stderr),
    `artifacts.js` (PNG/SVG inline, CSV → first 50 rows + download via
    `downloadCsv` from `lib/utils.js`, JSON → collapsible tree).
  - `recipes.js` — "Saved analyses" list; each row: Run / View code / Download.
- `combined/view.js`: expose the asset selection it already owns — add an
  `onAssetChange(cb)` subscription next to the existing `currentAsset`
  bookkeeping (lines ~39/72/93). No behaviour change for existing callers
  (`project-entry.js`, `subject-entry.js` keep working; the panel mounts only
  from `view-entry.js`).
- `view-entry.js`: mount the panel after `bootstrap`. The floating `a//y`
  widget stays off `/view` to avoid two chat surfaces.
- `web/styles/partials/NN-analysis-panel.css`, `@import`ed from `app.css`.
- Config: add `ANALYSIS_API_BASE` to `web/src/constants.js` (same host as the
  existing `CHAT_ENDPOINT`); dev points at localhost portal.
- No `routes.js` change — this is a panel on an existing page.

## 3. Milestones

Each milestone is independently shippable and ends with stated proof.

**M1 — Sandbox tool.** `sandbox_tools.py` + `analysis_recipe_contract.txt` +
`asset_data_map.txt`, executor container, `tests/test_sandbox_tools.py`.
*Proof:* `run_python` produces a PNG from a real `asset_basics` query; timeout,
memory, and network-denial tests pass; run with creds stripped still works for
public cache reads.

**M2 — Streaming agent.** `stream_agent` + `POST /analysis/chat` SSE.
*Proof:* `curl -N` shows `tool_start`/`tool_end`/`artifact`/`done`; existing
`tests/test_chat.py` unchanged and green.

**M3 — Sidebar, iterate-only.** Panel, transcript, artifact rendering, asset
binding + abort. *Proof:* browser-driven on `/view?asset=…` — ask for a figure,
see code, stdout, and PNG; switch asset mid-run and confirm the request aborts.

**M4 — Package + re-run.** `/analysis/package` with the 5-step validator,
`store.py`, `/analysis/run`, `/analysis/recipes`, Saved-analyses UI.
*Proof:* package a figure recipe, hard-reload, run it on a *different* asset
from the sidebar and get the same figure with new data.

**M5 — Hardening.** ORCID gate on packaging, rate limits, audit log, artifact
retention lifecycle rules, cost cap per IP/day, docs
(`aind-data-mcp/README.md` skills section, zombie `AGENTS.md` page entry).

**M6 — Batch (optional).** `runtime: "batch"` executor path so a stored recipe
can fan out over a project and land results where `analysis_framework/view.js`
already reads them (DocDB `analysis` + S3 PNGs) — the dashboard becomes the
"packaged analyses at scale" view for free.

## 4. Risks and how they are handled

| Risk | Handling |
|---|---|
| Arbitrary code execution with portal credentials | Separate container, scoped read-only role, no inherited env, egress allow-list, rlimits. Never option A in production. |
| Agent writes code that "works" only on one asset | Multi-asset validation in packaging step 4 is mandatory, not advisory. |
| Prompt injection via asset metadata into code | Sandbox has no write scope outside its artifact prefix and no secrets to exfiltrate; egress allow-list blocks callbacks. |
| Bedrock cost blowout from long loops | Reuse `MAX_ITERATIONS`/`MAX_TOOL_CALLS`; add per-IP daily token budget in `ratelimit.py`. |
| Two chat surfaces confusing users | Panel replaces `a//y` on `/view`; shared transcript renderer so behaviour matches. |
| Recipe rot when cache schema changes | `recipe.json` pins cache version + column list; `/analysis/run` warns on drift instead of silently plotting nothing. |
| Sandbox becomes the de facto data API | `run_python` stays behind the analysis agent + rate limits; it is not added to the public `/mcp` tool set (add to `DISABLED_TOOLS` for the HTTP mount). |

## 5. Open questions

1. **Executor hosting** — can we run a sibling container in the portal's ECS
   task (M1 option B), or must heavy execution go to Code Ocean from day one?
2. **Auth for iteration** — packaging is ORCID-gated. Should *iterating*
   (which burns Bedrock + CPU) also require login, or stay anonymous with
   tight rate limits like `/chat`?
3. **Recipe visibility** — are packaged recipes global (everyone sees every
   saved analysis on every matching asset) or per-author with explicit publish?
4. **Recipe store** — S3 + `registry.json` (mirrors `cache_registry`, readable
   by zombie with no new endpoint) vs DocDB `analysis` database (already used by
   `analysis_framework/view.js`, gives provenance queries). Plan assumes S3 for
   code, DocDB later for batch run records.
5. **Raw NWB in v1** — allow recipes to touch multi-GB HDF5 (needs `runtime:
   "batch"` and minutes of CPU), or restrict v1 to cache parquet +
   `platform_swdb_*` and defer NWB to M6?
6. **Model** — reuse `us.anthropic.claude-sonnet-4` from `/chat`, or a stronger
   model for code authoring given the iteration loop is the expensive part?
