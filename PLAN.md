# QC View Page Implementation Plan

## Overview

Create a read-only Quality Control viewer page at `/quality_control.html` that replicates the view endpoint of [aind-qc-portal](https://github.com/AllenNeuralDynamics/aind-qc-portal) but rendered entirely in vanilla HTML/JS (no Panel/Python). The page loads an asset by name via `?name=<asset-name>` and displays its QC metadata with a navigable tree hierarchy and metric details.

## Architecture

This follows the existing zombie multi-page pattern:
- `web/quality_control.html` — HTML shell (same template as `subject.html`)
- `web/src/qc-entry.js` — Entry point that reads `?name=` from URL and bootstraps the view
- `web/src/qc/view.js` — Main view orchestrator
- `web/src/qc/data.js` — Data fetching and parsing (DocDB + S3 references)
- `web/src/qc/tree.js` — Left-side hierarchy tree component
- `web/src/qc/metrics.js` — Right-side metric display (accordion of metric groups)
- `web/src/qc/media.js` — Reference/media rendering (images, videos, iframes, etc.)
- Register new page in `web/vite.config.js` under `rollupOptions.input`
- Add nav link to header in all HTML files (under "Dashboards" dropdown)
- Add CSS for QC-specific components to `web/styles/app.css`

## Data Flow

### 1. Fetch record from DocDB

Use the existing `queryDocDb()` helper from `web/src/lib/docdb.js`:

```javascript
import { queryDocDb } from '../lib/docdb.js';

const records = await queryDocDb(
  { name: assetName },
  { limit: 1 }
);
const record = records[0];
```

The DocDB proxy at `/docdb/metadata/search` handles forwarding. The record has this shape (relevant fields):

```json
{
  "_id": "...",
  "name": "asset-name-here",
  "location": "s3://aind-open-data/asset-name-here",
  "data_description": {
    "project_name": "...",
    "source_data": ["raw-asset-name"]
  },
  "other_identifiers": { "Code Ocean": ["co-id-here"] },
  "quality_control": {
    "default_grouping": ["probe", "type"],
    "metrics": [
      {
        "name": "metric name",
        "description": "markdown description",
        "value": <any>,
        "reference": "figures/my_figure.png",
        "tags": {"probe": "probeA", "type": "motion correction"},
        "stage": "Raw data",
        "modality": {"abbreviation": "ecephys", "name": "Extracellular electrophysiology"},
        "status_history": [{"status": "Pass", "timestamp": "...", "user": "..."}],
        "object_type": "QC metric"
      }
    ]
  }
}
```

### 2. Parse the S3 location

From `record.location` (e.g. `"s3://aind-open-data/asset-name-here"`):
- `s3Bucket = "aind-open-data"`
- `s3Prefix = "asset-name-here"`

The `aind-open-data` bucket is **public**. Files are accessed via HTTPS:
```
https://aind-open-data.s3.us-west-2.amazonaws.com/{s3Prefix}/{reference_path}
```

For example, a metric with `reference: "figures/drift_map.png"` resolves to:
```
https://aind-open-data.s3.us-west-2.amazonaws.com/asset-name-here/figures/drift_map.png
```

### 3. Build the hierarchy tree

The hierarchy is built from `quality_control.default_grouping` and each metric's `tags`:

- `default_grouping` is a list like `["probe", "type"]` defining hierarchy levels
- If there are multiple modalities across metrics, prepend `"modality"` as the first level
- At each level, group metrics by the tag key's value
- Each node shows: `"{tag_key}: {tag_value} ({count})"` and an aggregated status icon

**Status aggregation rules:**
- If ANY metric in a node has status "Fail" → node is "Fail"
- Else if ANY has "Pending" → node is "Pending"
- Else → "Pass"

**Status comes from:** `metric.status_history[last].status` (default "Pending" if empty)

### 4. Display metrics (right panel)

When a tree node is selected, show its metrics. Metrics are **grouped by shared `reference`**:

- All metrics sharing the same `reference` string are displayed together in one accordion section
- Each accordion section title is the reference filename or type description
- Within each section: left column has metric details, right column has the media

**Metric detail display (read-only):**
- Name (bold)
- Description (rendered as markdown — support `[text](url)` links)
- Modality, Stage, Tags
- Value (displayed based on type — see below)
- Status (colored: green=Pass, red=Fail, blue=Pending)

**Value type rendering:**
| Type | Display |
|------|---------|
| Number/String/Boolean | Plain text |
| List | Simple table with one "values" column |
| Dict with equal-length list values | Table (keys=columns, values=rows). If key "index" (case-insensitive) exists, use as row labels |
| Dict (other) | JSON formatted display |

### 5. Media/reference rendering

Resolve the reference string to a displayable element:

| Reference pattern | Action |
|---|---|
| Ends with `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, `.tiff` | `<img>` tag |
| Ends with `.mp4`, `.avi`, `.webm` | `<video>` tag with controls |
| Ends with `.pdf` | `<iframe>` or `<embed>` |
| Contains `neuroglancer` | `<iframe src="{url}">` |
| Contains `sortingview` or `figurl` | `<iframe src="{url}">` |
| Contains `ephys.allenneuraldynamics.org` | `<iframe src="{url}">` |
| Contains `rrd` (Rerun) | `<iframe>` pointing to `https://app.rerun.io/version/{version}/index.html?url={encoded_data_url}`. Extract version from filename pattern `_vX.Y.Z.rrd`, default `0.19.1` |
| Starts with `http` (other URLs) | Clickable link |
| Contains `s3://` | Parse bucket/key, build HTTPS URL, then apply above rules based on extension |
| Contains `;` (semicolons) | Two references side-by-side (split on `;`, render each independently) |
| Relative path (e.g. `figures/foo.png`) | Resolve to `https://{s3Bucket}.s3.us-west-2.amazonaws.com/{s3Prefix}/{path}` |

**Important:** Strip any leading `/` or `results/` prefix from relative references before resolving.

## UI Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [Logo] allen institute / neural dynamics / quality control   [Edit] btn │
│ Assets | Subjects | Contributions | Dashboards ▾          [theme toggle]│
├─────────────────────────────────────────────────────────────────────────┤
│ HEADER                                                                  │
│ ## {asset_name}                                                         │
│ Modalities: ecephys, ... | Stages: Raw data, ...                        │
│ Links: Project page | Metadata viewer | Code Ocean                      │
├──────────────────┬──────────────────────────────────────────────────────┤
│ TREE (left)      │ METRIC CONTENT (right)                               │
│                  │                                                      │
│ ▶ modality:      │  ┌─ Accordion Section (shared reference) ──────────┐ │
│   ecephys (12)   │  │  ┌─────────────┐  ┌───────────────────────────┐ │ │
│   ▶ probe:       │  │  │ Metric 1    │  │                           │ │ │
│     probeA (6)   │  │  │ name/desc   │  │   [IMAGE/VIDEO/IFRAME]    │ │ │
│     ▶ type:      │  │  │ value       │  │                           │ │ │
│       drift (3)  │  │  │ status ●    │  │                           │ │ │
│       noise (3)  │  │  ├─────────────┤  │                           │ │ │
│     probeB (6)   │  │  │ Metric 2    │  │                           │ │ │
│                  │  │  │ ...         │  │                           │ │ │
│                  │  │  └─────────────┘  └───────────────────────────┘ │ │
│                  │  └─────────────────────────────────────────────────┘ │
│                  │  ┌─ Accordion Section 2 ───────────────────────────┐ │
│                  │  │ ...                                             │ │
│                  │  └─────────────────────────────────────────────────┘ │
└──────────────────┴──────────────────────────────────────────────────────┘
```

## "Edit" Button Behavior

Top-right corner: an "Edit" button that navigates to the QC Portal for this asset:
```javascript
const editUrl = `https://qc.allenneuraldynamics.org/view?name=${encodeURIComponent(assetName)}`;
window.open(editUrl, '_blank');
```

## Header Links

- **Project page**: `https://qc.allenneuraldynamics.org/portal?projects=['${projectName}']`
- **Metadata viewer**: `https://metadata-portal.allenneuraldynamics.org/view?name=${assetName}`
- **Code Ocean**: `https://codeocean.allenneuraldynamics.org/data_assets/${coId}` (if `other_identifiers["Code Ocean"]` exists)

## File-by-File Implementation Details

### `web/quality_control.html`

Copy the template from `subject.html`. Changes:
- Title: "Quality Control"
- Brand sub text: "quality control"
- Add `aria-current="page"` on the QC nav link
- Entry script: `<script type="module" src="/src/qc-entry.js"></script>`
- Add an "Edit" button in the header area (right side, styled as a link/button)

### `web/src/qc-entry.js`

```javascript
import { queryDocDb } from './lib/docdb.js';
import { createQCView } from './qc/view.js';

async function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const assetName = params.get('name');

  if (!assetName) {
    app.innerHTML = '<p class="qc-empty">No asset specified. Use ?name=&lt;asset-name&gt;</p>';
    return;
  }

  app.innerHTML = '<p class="qc-loading">Loading QC data...</p>';

  try {
    const records = await queryDocDb({ name: assetName }, { limit: 1 });
    if (!records.length) {
      app.innerHTML = `<p class="qc-error">Asset "${assetName}" not found in DocDB.</p>`;
      return;
    }
    app.innerHTML = '';
    app.appendChild(createQCView(records[0]));
  } catch (err) {
    app.innerHTML = `<p class="qc-error">Failed to load: ${err.message}</p>`;
  }
}

init();
```

### `web/src/qc/data.js`

Exports:
- `parseQCRecord(record)` → returns `{ name, s3Bucket, s3Prefix, projectName, codeOceanId, modalities, stages, metrics, defaultGrouping }`
- `getMetricStatus(metric)` → returns the latest status string from `status_history`
- `resolveReference(reference, s3Bucket, s3Prefix)` → returns `{ url, type }` where type is one of: `image`, `video`, `pdf`, `iframe`, `rerun`, `link`, `text`
- `buildTreeNodes(metrics, defaultGrouping)` → returns nested tree structure
- `aggregateStatus(metrics)` → returns "Pass"/"Fail"/"Pending"

Key implementation notes:
- For relative references, build URL as: `https://${s3Bucket}.s3.us-west-2.amazonaws.com/${s3Prefix}/${cleanedRef}`
- Strip `results/` prefix and leading `/` from references
- Parse `metric.tags` — they may be stored as JSON strings (prefixed with `json:`) or plain dicts
- `metric.value` may also be JSON-encoded with `json:` prefix

### `web/src/qc/tree.js`

Exports:
- `createTree(treeNodes, onSelect)` → returns a DOM element

Implementation:
- Render as nested `<ul>/<li>` with expand/collapse toggles
- Each node shows a status icon (colored circle or unicode character) + label
- Clicking a leaf or node calls `onSelect(node)` with the node's `metricRows`
- Use CSS classes for expand/collapse state (no library needed)
- Status colors: Pass=#1D8649, Fail=#c0392b, Pending=#555555

### `web/src/qc/metrics.js`

Exports:
- `renderMetrics(metricRows, s3Bucket, s3Prefix)` → returns a DOM element

Implementation:
- Group metrics by `reference` field (metrics with same reference go together)
- For each group, create an accordion `<details>/<summary>` element
- Summary shows the reference filename/type and count of metrics
- Inside: two-column layout — left has metric cards, right has media
- First accordion section is open by default

**Metric card content (read-only):**
- `<strong>` name
- Description (parse markdown links `[text](url)` → `<a>` tags)
- Tags displayed as `key: value` pills
- Value rendered by type (see table above)
- Status with colored dot

### `web/src/qc/media.js`

Exports:
- `renderMedia(reference, s3Bucket, s3Prefix)` → returns a DOM element

Implementation:
- Resolve reference URL using logic from `data.js`
- For images: `<img src="..." loading="lazy" style="max-width:100%">`
- For videos: `<video controls src="..." style="max-width:100%">`
- For PDFs: `<iframe src="..." style="width:100%;height:600px">`
- For neuroglancer/figurl/sortingview: `<iframe src="..." style="width:100%;height:600px">`
- For rerun (`.rrd`): `<iframe src="https://app.rerun.io/version/{ver}/index.html?url={encoded}" style="width:100%;height:600px">`
- For semicolon references: render both side by side in a flex container
- For plain links: `<a href="..." target="_blank">Open reference</a>`
- Include a fullscreen toggle button (small icon in corner of media area)

### `web/vite.config.js`

Add to `rollupOptions.input`:
```javascript
quality_control: resolve(__dirname, 'quality_control.html'),
```

### `web/styles/app.css`

Add QC-specific styles at the end of the file:

```css
/* QC View */
.qc-container { display: flex; gap: var(--gap); padding: var(--gap); height: calc(100vh - 60px); }
.qc-header { padding: var(--gap); border-bottom: 1px solid var(--surface-border); }
.qc-header h2 { margin: 0 0 4px; }
.qc-header-links a { margin-right: 12px; color: var(--color-red); }
.qc-tree { width: 280px; min-width: 200px; overflow-y: auto; border-right: 1px solid var(--surface-border); padding-right: var(--gap); }
.qc-tree ul { list-style: none; padding-left: 16px; margin: 0; }
.qc-tree li { cursor: pointer; padding: 4px 0; }
.qc-tree .tree-node { display: flex; align-items: center; gap: 6px; }
.qc-tree .tree-toggle { width: 16px; text-align: center; cursor: pointer; user-select: none; }
.qc-tree .tree-icon { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.qc-tree .tree-icon.pass { background: #1D8649; }
.qc-tree .tree-icon.fail { background: #c0392b; }
.qc-tree .tree-icon.pending { background: #555555; }
.qc-tree .tree-children { display: none; }
.qc-tree .tree-children.expanded { display: block; }
.qc-content { flex: 1; overflow-y: auto; }
.qc-accordion details { border: 1px solid var(--surface-border); border-radius: var(--radius); margin-bottom: 8px; }
.qc-accordion summary { padding: 10px 14px; cursor: pointer; font-weight: 600; background: var(--surface-card); }
.qc-accordion .accordion-body { display: flex; gap: var(--gap); padding: var(--gap); }
.qc-metric-card { border: 1px solid var(--surface-border); border-radius: var(--radius); padding: 12px; margin-bottom: 8px; background: var(--surface-card); }
.qc-metric-card .metric-name { font-weight: 600; margin-bottom: 4px; }
.qc-metric-card .metric-desc { font-size: 0.85em; color: var(--text-secondary); margin-bottom: 8px; }
.qc-metric-card .metric-tags { font-size: 0.8em; color: var(--text-muted); margin-bottom: 4px; }
.qc-metric-card .metric-value { margin: 8px 0; }
.qc-metric-card .metric-status { display: flex; align-items: center; gap: 6px; }
.qc-metric-card .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.qc-media { flex: 1; min-width: 0; }
.qc-media img, .qc-media video { max-width: 100%; height: auto; border-radius: var(--radius); }
.qc-media iframe { width: 100%; height: 600px; border: 1px solid var(--surface-border); border-radius: var(--radius); }
.qc-edit-btn { background: var(--color-red); color: #fff; border: none; padding: 6px 16px; border-radius: var(--radius); cursor: pointer; font-weight: 500; }
.qc-edit-btn:hover { background: var(--color-red-hover); }
.qc-loading, .qc-error, .qc-empty { padding: 40px; text-align: center; color: var(--text-secondary); }
```

## Navigation Update

Add "Quality Control" to the Dashboards dropdown in ALL HTML files:
```html
<div class="app-nav-dropdown-menu">
  <a href="/sessions">Sessions</a>
  <a href="/smartspim">SmartSPIM</a>
  <a href="/quality_control">Quality Control</a>
</div>
```

## Tests

Create `web/src/__tests__/qc-data.test.js` and `web/src/__tests__/qc-tree.test.js`:

**qc-data.test.js** should test:
- `parseQCRecord()` extracts fields correctly
- `getMetricStatus()` returns correct status from history
- `resolveReference()` builds correct URLs for various reference types
- `buildTreeNodes()` creates proper hierarchy from metrics + grouping
- `aggregateStatus()` applies fail > pending > pass logic

**qc-tree.test.js** should test:
- `createTree()` builds correct DOM structure
- Node click fires `onSelect` with correct metric rows

## Implementation Order

1. Create `web/quality_control.html` (copy template, adjust title/nav/script)
2. Create `web/src/qc/data.js` (pure data logic, no DOM)
3. Create `web/src/qc/tree.js` (tree component)
4. Create `web/src/qc/media.js` (media resolver)
5. Create `web/src/qc/metrics.js` (metric display)
6. Create `web/src/qc/view.js` (orchestrator)
7. Create `web/src/qc-entry.js` (entry point)
8. Update `web/vite.config.js` (add input)
9. Update nav in all HTML files (add dropdown link)
10. Add CSS to `web/styles/app.css`
11. Write tests

## Notes for Implementer

- **No editing capability** — everything is read-only display. No forms, no submit buttons, no status selectors.
- **No authentication** — S3 buckets are public (`aind-open-data`), DocDB is hit through the existing proxy with no auth.
- **The DocDB proxy** is already running at `/docdb` (Vite dev proxy → localhost:3001 → `aind_data_access_api`). Reuse the existing `queryDocDb()` from `web/src/lib/docdb.js`.
- **Do not add any new npm dependencies.** Use vanilla DOM APIs only.
- **Follow existing patterns**: no comments in code, no linting, use the `.venv`, use the existing CSS variable system.
- **Markdown in descriptions**: only need to handle `[text](url)` link syntax → convert to `<a href="url" target="_blank">text</a>`.
- **The `tags` field** on metrics may be a JSON-encoded string (prefixed with `json:`) or a plain object. Handle both: if string starts with `json:`, parse `JSON.parse(str.slice(5))`.
- **The `value` field** may also use the `json:` prefix encoding. Same treatment.
- **Tree expand/collapse** can use CSS `.expanded` class toggling — no need for a library.
- **Accordion** should use native `<details>/<summary>` HTML elements.
