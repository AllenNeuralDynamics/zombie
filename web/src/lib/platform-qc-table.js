/**
 * lib/platform-qc-table.js — QC pass-rate table for platform overview sections.
 *
 * Loads a pre-computed platform QC parquet (one per platform) from S3,
 * registers it as a DuckDB table, and renders a pivot table showing pass rates
 * per group (rig or experimenter) × metric name.
 *
 * Schema of each platform QC parquet:
 *   asset_name, subject_id, instrument_id, experimenter,
 *   tag, status, timestamp
 *
 * Users can filter which metric columns are visible via the gear settings.
 *
 * @module
 */

import { escHtml, normalizeInstrumentIdSql } from './utils.js';

const S3_BASE =
  'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache';

/** S3 URL for each platform's pre-computed QC parquet. */
const PLATFORM_QC_URLS = {
  spim:             `${S3_BASE}/zs_platform_qc/spim.pqt`,
  fib:              `${S3_BASE}/zs_platform_qc/fib.pqt`,
  vr:               `${S3_BASE}/zs_platform_qc/vr.pqt`,
  dynamic_foraging: `${S3_BASE}/zs_platform_qc/dynamic_foraging.pqt`,
};

/** DuckDB table name for a given platform key. */
const tableNameFor = (key) => `platform_qc_${key}`;

/** Cache: platformKey → Promise (resolves when table is registered in DuckDB). */
const _tableReady = new Map();

async function ensurePlatformTable(coord, platformKey) {
  if (!_tableReady.has(platformKey)) {
    const url = PLATFORM_QC_URLS[platformKey];
    if (!url) throw new Error(`Unknown platform QC key: ${platformKey}`);
    const tbl = tableNameFor(platformKey);
    const p = coord
      .exec(`CREATE OR REPLACE TABLE ${tbl} AS SELECT * FROM read_parquet('${url}')`)
      .catch((err) => { _tableReady.delete(platformKey); throw err; });
    _tableReady.set(platformKey, p);
  }
  return _tableReady.get(platformKey);
}

/**
 * SQL expression that produces the group label from a row.
 * - 'rig': normalize instrument_id, stripping legacy <loc>_<name>_<date> patterns
 * - 'experimenter': use the experimenter column directly (already one value per row)
 */
function groupExprFor(groupBy) {
  if (groupBy === 'experimenter') return 'experimenter';
  return normalizeInstrumentIdSql('instrument_id');
}

/**
 * Query DuckDB and return flat rows:
 *   { grp, n_sessions, tag, n_pass, n_fail, n_pending, n_total }
 *
 * n_sessions counts distinct assets across ALL metrics (not filtered by
 * visible selection), so it always reflects the full group size.
 */
async function fetchStats(coord, { platformKey, groupBy }) {
  await ensurePlatformTable(coord, platformKey);
  const tbl = tableNameFor(platformKey);
  const grp = groupExprFor(groupBy);

  const sql = `
    WITH grp_sessions AS (
      SELECT ${grp} AS grp,
             COUNT(DISTINCT asset_name) AS n_sessions
      FROM ${tbl}
      GROUP BY grp
    ),
    grp_metrics AS (
      SELECT ${grp} AS grp,
             tag,
             COUNT(*) FILTER (WHERE status = 'Pass')    AS n_pass,
             COUNT(*) FILTER (WHERE status = 'Fail')    AS n_fail,
             COUNT(*) FILTER (WHERE status = 'Pending') AS n_pending,
             COUNT(*) AS n_total
      FROM ${tbl}
      GROUP BY grp, tag
    )
    SELECT s.grp,
           s.n_sessions,
           m.tag,
           m.n_pass,
           m.n_fail,
           m.n_pending,
           m.n_total
    FROM grp_sessions s
    JOIN grp_metrics m ON m.grp = s.grp
    WHERE s.grp IS NOT NULL AND s.grp != ''
    ORDER BY s.n_sessions DESC, s.grp, m.tag
  `;

  const result = await coord.query(sql, { type: 'json' });
  return Array.isArray(result) ? result
       : Array.isArray(result?.data) ? result.data
       : Array.from(result ?? []);
}

/**
 * Organize flat rows into a structure convenient for rendering.
 *
 * @returns {{
 *   groupOrder: { grp: string, n_sessions: number }[],
 *   metrics: string[],
 *   data: Map<string, Map<string, { n_pass, n_fail, n_pending, n_total }>>
 * }}
 */
function organizeStats(rows) {
  const seenGroups = new Set();
  const groupOrder = [];
  const metricSet  = new Set();
  const data       = new Map(); // grp → Map<tag, counts>

  for (const row of rows) {
    const grp    = String(row.grp ?? '');
    const metric = String(row.tag ?? '');
    metricSet.add(metric);
    if (!seenGroups.has(grp)) {
      seenGroups.add(grp);
      groupOrder.push({ grp, n_sessions: Number(row.n_sessions ?? 0) });
      data.set(grp, new Map());
    }
    data.get(grp).set(metric, {
      n_pass:    Number(row.n_pass    ?? 0),
      n_fail:    Number(row.n_fail    ?? 0),
      n_pending: Number(row.n_pending ?? 0),
      n_total:   Number(row.n_total   ?? 0),
    });
  }

  return { groupOrder, metrics: [...metricSet].sort(), data };
}

/**
 * Create a live QC stats table widget for a platform.
 *
 * @param {object} coord
 * @param {object} opts
 * @param {string}               opts.platformKey     'spim' | 'fib' | 'vr'
 * @param {'rig'|'experimenter'} [opts.groupBy]
 * @param {Set<string>|null}     [opts.visibleMetrics]  null = show all
 * @returns {{
 *   el: HTMLElement,
 *   setGroupBy(gb: string): void,
 *   setVisibleMetrics(vis: Set|null): void,
 *   onMetricsDiscovered(cb: (metrics: string[]) => void): void,
 * }}
 */
export function createPlatformQcTable(coord, {
  platformKey,
  groupBy = 'rig',
  visibleMetrics = null,
} = {}) {
  let _groupBy   = groupBy;
  let _visible   = visibleMetrics;
  let _organized = null;  // { groupOrder, metrics, data }
  let _metricsCb = null;

  const container = document.createElement('div');
  container.className = 'platform-qc-table-wrap';

  function renderTable() {
    container.innerHTML = '';
    if (!_organized) {
      const p = document.createElement('p');
      p.className = 'platform-qc-loading';
      p.textContent = 'Loading QC stats…';
      container.appendChild(p);
      return;
    }

    const { groupOrder, metrics, data } = _organized;
    if (!groupOrder.length) {
      const p = document.createElement('p');
      p.className = 'platform-qc-empty';
      p.textContent = 'No QC data available for this platform.';
      container.appendChild(p);
      return;
    }

    const shownMetrics = _visible
      ? metrics.filter((m) => _visible.has(m))
      : metrics;

    const groupLabel = _groupBy === 'experimenter' ? 'Experimenter' : 'Rig';

    let html = `<table class="platform-qc-table"><thead><tr>`;
    html += `<th class="qc-th-group">${groupLabel}</th>`;
    html += `<th class="qc-th-n" title="Distinct assets in this group">Sessions</th>`;
    for (const m of shownMetrics) {
      const mDisplay = m.includes(':') ? m.slice(m.indexOf(':') + 1) : m;
      html += `<th class="qc-th-metric" title="${escHtml(m)}">${escHtml(mDisplay)}</th>`;
    }
    html += `</tr></thead><tbody>`;

    for (const { grp, n_sessions } of groupOrder) {
      const metricMap = data.get(grp) ?? new Map();
      html += `<tr>`;
      html += `<td class="qc-td-group">${escHtml(grp)}</td>`;
      html += `<td class="qc-td-n">${n_sessions.toLocaleString()}</td>`;
      for (const m of shownMetrics) {
        const c = metricMap.get(m);
        if (!c || c.n_total === 0) {
          html += `<td class="qc-td-pct qc-pct-none">—</td>`;
        } else {
          const pct = Math.round((c.n_pass / c.n_total) * 100);
          const cls = pct >= 90 ? 'qc-pct-high' : pct >= 70 ? 'qc-pct-mid' : 'qc-pct-low';
          const tip = `Pass: ${c.n_pass}, Fail: ${c.n_fail}, Pending: ${c.n_pending}`;
          html += `<td class="qc-td-pct ${cls}" title="${escHtml(tip)}">${pct}%</td>`;
        }
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    container.innerHTML = html;
  }

  function load() {
    container.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'platform-qc-loading';
    p.textContent = 'Loading QC stats…';
    container.appendChild(p);

    fetchStats(coord, { platformKey, groupBy: _groupBy })
      .then((rows) => {
        _organized = organizeStats(rows);
        if (_metricsCb) _metricsCb(_organized.metrics);
        renderTable();
      })
      .catch((err) => {
        container.innerHTML = '';
        const p2 = document.createElement('p');
        p2.className = 'platform-qc-error';
        p2.textContent = `QC stats unavailable: ${err?.message ?? err}`;
        container.appendChild(p2);
      });
  }

  load();

  return {
    el: container,
    get metrics() { return _organized?.metrics ?? []; },
    setGroupBy(gb) {
      if (gb === _groupBy) return;
      _groupBy = gb;
      _organized = null;
      load();
    },
    setVisibleMetrics(vis) {
      _visible = vis;
      renderTable();
    },
    onMetricsDiscovered(cb) {
      _metricsCb = cb;
      if (_organized) cb(_organized.metrics);
    },
  };
}
