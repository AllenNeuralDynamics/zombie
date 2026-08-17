import * as Plot from '@observablehq/plot';
import { arrowTableToRows } from '../lib/arrow.js';
import { ensureTable } from '../lib/registry.js';

export async function createV2View({ coordinator }) {
  const root = document.createElement('div');
  root.className = 'v2-page';

  const h1 = document.createElement('h1');
  h1.textContent = 'V2 Acquisitions';
  root.appendChild(h1);

  const desc = document.createElement('p');
  desc.className = 'v2-desc';
  desc.textContent = 'Acquisitions from the last 30 days.';
  root.appendChild(desc);

  if (!coordinator) {
    root.appendChild(Object.assign(document.createElement('p'), {
      className: 'loading-message error',
      textContent: 'DuckDB unavailable.',
    }));
    return root;
  }

  const container = document.createElement('div');
  container.className = 'v2-chart-container';
  container.textContent = 'Loading…';
  root.appendChild(container);

  try {
    await ensureTable(coordinator, 'metadata_upgrade');

    const result = await coordinator.query(`
      SELECT
        ab.name,
        ab.project_name,
        CAST(ab.acquisition_start_time AS DATE) AS acq_date,
        CASE
          WHEN mu.name IS NULL OR mu._id IS NULL THEN 'v2 only'
          ELSE 'v1 + v2'
        END AS db_status
      FROM asset_basics ab
      LEFT JOIN metadata_upgrade mu ON ab.name = mu.name
      WHERE ab.acquisition_start_time >= CURRENT_DATE - INTERVAL '30 days'
        AND ab.project_name IS NOT NULL
        AND ab.project_name != ''
      ORDER BY ab.project_name, acq_date
    `);

    const rows = arrowTableToRows(result);

    container.textContent = '';

    if (!rows.length) {
      container.textContent = 'No acquisitions found in the last 30 days.';
      return root;
    }

    const projectOrder = [...new Set(rows.map((r) => r.project_name))].sort();

    // For each (date, project) group, spread dots slightly along x so they
    // don't overlap. Step of 2 hours in ms — small enough to stay visually
    // on the same date tick, large enough to be distinguishable.
    const STEP_MS = 2 * 60 * 60 * 1000;
    const groupCounts = new Map();
    for (const row of rows) {
      const key = `${row.acq_date}||${row.project_name}`;
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
    const groupIndex = new Map();
    const jitteredRows = rows.map((row) => {
      const key = `${row.acq_date}||${row.project_name}`;
      const idx = groupIndex.get(key) ?? 0;
      groupIndex.set(key, idx + 1);
      const n = groupCounts.get(key);
      const offset = (idx - (n - 1) / 2) * STEP_MS;
      return { ...row, x_pos: new Date(new Date(row.acq_date).getTime() + offset) };
    });

    const buildPlot = () => {
      // Plot bakes the resolved text colour into inline SVG attributes, so we
      // read the themed value at (re)build time rather than relying on CSS.
      const rootStyle = getComputedStyle(document.documentElement);
      const textColor = rootStyle.getPropertyValue('--text-primary').trim() || '#111111';
      // Tooltips read `--plot-background` (defaults to white); theme it so the
      // tip background flips and stays legible in dark mode.
      const bgColor = rootStyle.getPropertyValue('--surface-bg').trim() || '#ffffff';
      const plotEl = Plot.plot({
        width: Math.max(800, (document.documentElement.clientWidth || 1200) - 56),
        height: Math.max(300, projectOrder.length * 22 + 80),
        marginLeft: 240,
        marginBottom: 40,
        style: { background: 'transparent', fontFamily: 'inherit', color: textColor },
        x: {
          label: 'Acquisition date',
          // Inset the data area so the earliest dots clear the project labels
          // on the left (and don't clip on the right).
          insetLeft: 24,
          insetRight: 18,
          domain: [(() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })(), new Date()],
          tickFormat: (d) => {
            const dt = d instanceof Date ? d : new Date(d);
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
        },
        y: {
          label: null,
          domain: projectOrder,
          // Project names can be far longer than the left margin; truncate the
          // tick label so it fits (full name is in the dot tooltip).
          tickFormat: (name) => (name.length > 34 ? name.slice(0, 33) + '…' : name),
        },
        color: {
          legend: true,
          domain: ['v2 only', 'v1 + v2'],
          range: ['#22c55e', '#ef4444'],
        },
        marks: [
          Plot.dot(jitteredRows, {
            x: 'x_pos',
            y: 'project_name',
            fill: 'db_status',
            r: 4,
            opacity: 0.8,
            tip: true,
            title: (d) => `${d.project_name}\n${d.name}\n${d.db_status}`,
          }),
        ],
      });
      // Custom properties can't go through Plot's `style` object (it uses
      // Object.assign, which ignores `--*`), so set it directly. This themes
      // the tooltip background, which reads `var(--plot-background)`.
      plotEl.style.setProperty('--plot-background', bgColor);
      return plotEl;
    };

    const renderPlot = () => {
      container.textContent = '';
      container.appendChild(buildPlot());
    };
    renderPlot();

    // Rebuild when the theme changes so baked-in text colours stay readable.
    const themeObserver = new MutationObserver(renderPlot);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch (err) {
    container.textContent = '';
    container.appendChild(Object.assign(document.createElement('p'), {
      className: 'loading-message error',
      textContent: `Failed to load data: ${err.message}`,
    }));
  }

  return root;
}
