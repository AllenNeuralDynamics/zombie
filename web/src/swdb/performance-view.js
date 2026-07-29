/**
 * swdb/performance-view.js — per-block task performance for one SWDB asset.
 *
 * The merged NWB ships a computed `intervals/performance` table, so these numbers
 * are the pipeline's own scoring rather than anything re-derived here. A Dynamic
 * Routing session alternates visual- and auditory-rewarded blocks, so the
 * interesting quantity is the *cross-modality* d-prime: how well the subject
 * responds to the currently-rewarded modality's target versus the other
 * modality's. It is plotted per block alongside the within-modality d-primes, and
 * the block table below carries the underlying rates.
 */

import * as Plot from '@observablehq/plot';
import { escHtml } from '../lib/utils.js';
import { loadPerformance } from './data.js';

const VIS_COLOR = '#7c3aed';
const AUD_COLOR = '#f59e0b';

/**
 * Coerce the cached performance rows to plain numbers.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function normalisePerformance(rows) {
  const num = (v) => {
    if (v == null) return null;
    const n = typeof v === 'bigint' ? Number(v) : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return rows
    .map((r) => ({
      block: num(r.block_index),
      rewardedMod: r.rewarded_modality ?? null,
      start_t: num(r.start_time),
      stop_t: num(r.stop_time),
      nTrials: num(r.n_trials),
      nResponses: num(r.n_responses),
      nHits: num(r.n_hits),
      nRewards: num(r.n_contingent_rewards),
      hitRate: num(r.hit_rate),
      faRate: num(r.false_alarm_rate),
      catchRate: num(r.catch_response_rate),
      visDprime: num(r.vis_dprime),
      audDprime: num(r.aud_dprime),
      crossDprime: num(r.cross_modality_dprime),
      signedCrossDprime: num(r.signed_cross_modality_dprime),
    }))
    .sort((a, b) => (a.block ?? 0) - (b.block ?? 0));
}

/**
 * Build the performance panel for one SWDB asset.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {string} assetName
 * @returns {HTMLElement}
 */
export function createSwdbPerformanceView(coord, assetName) {
  const root = document.createElement('section');
  root.className = 'swdb-performance';
  root.innerHTML = '<div class="swdb-panel-status">Loading performance…</div>';

  const ctrl = new AbortController();

  (async () => {
    try {
      const rows = normalisePerformance(await loadPerformance(coord, assetName));
      if (ctrl.signal.aborted) return;
      if (rows.length === 0) {
        root.innerHTML = '<div class="swdb-panel-status">No performance data cached for this asset.</div>';
        return;
      }
      root.replaceChildren();
      root.appendChild(buildDprimeChart(rows));
      root.appendChild(buildBlockTable(rows));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      root.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Error loading performance: ${err.message}`;
      root.appendChild(msg);
      console.error('[SWDB] performance load failed', err);
    }
  })();

  root._dispose = () => ctrl.abort();
  return root;
}

function buildDprimeChart(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'swdb-perf-chart';

  const series = [];
  for (const r of rows) {
    if (r.crossDprime != null) series.push({ block: r.block + 1, metric: 'cross-modality', value: r.crossDprime });
    if (r.visDprime != null) series.push({ block: r.block + 1, metric: 'visual', value: r.visDprime });
    if (r.audDprime != null) series.push({ block: r.block + 1, metric: 'auditory', value: r.audDprime });
  }

  // Background bands showing which modality each block rewarded — the d-prime
  // series is only interpretable against that alternation.
  const bands = rows.map((r) => ({
    x1: r.block + 0.5,
    x2: r.block + 1.5,
    mod: r.rewardedMod,
  }));

  wrap.appendChild(
    Plot.plot({
      height: 240,
      marginLeft: 55,
      marginBottom: 40,
      color: {
        legend: true,
        domain: ['cross-modality', 'visual', 'auditory'],
        range: ['#111827', VIS_COLOR, AUD_COLOR],
      },
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'block', ticks: rows.map((r) => r.block + 1) },
      y: { label: "d'", grid: true, zero: true },
      marks: [
        Plot.rect(bands, {
          x1: 'x1',
          x2: 'x2',
          fill: (d) => (d.mod === 'aud' ? AUD_COLOR : VIS_COLOR),
          fillOpacity: 0.1,
        }),
        Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.3 }),
        Plot.line(series, { x: 'block', y: 'value', stroke: 'metric', strokeWidth: 1.5 }),
        Plot.dot(series, { x: 'block', y: 'value', fill: 'metric', r: 3.5 }),
      ],
    }),
  );

  const caption = document.createElement('div');
  caption.className = 'swdb-panel-caption';
  caption.textContent =
    "Per-block d′. Background shading marks the rewarded modality of each block "
    + '(purple = visual, amber = auditory).';
  wrap.appendChild(caption);
  return wrap;
}

function pct(v) {
  return v == null ? '–' : `${(v * 100).toFixed(0)}%`;
}

function dp(v) {
  return v == null ? '–' : v.toFixed(2);
}

function buildBlockTable(rows) {
  const table = document.createElement('table');
  table.className = 'swdb-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Block</th><th>Rewarded</th><th>Trials</th><th>Responses</th><th>Hits</th>
        <th>Hit rate</th><th>FA rate</th><th>Catch rate</th>
        <th>Cross d′</th><th>Vis d′</th><th>Aud d′</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `
        <tr>
          <td>${r.block + 1}</td>
          <td><span class="swdb-mod swdb-mod--${escHtml(r.rewardedMod ?? 'unknown')}">${escHtml(r.rewardedMod ?? '?')}</span></td>
          <td>${r.nTrials ?? '–'}</td>
          <td>${r.nResponses ?? '–'}</td>
          <td>${r.nHits ?? '–'}</td>
          <td>${pct(r.hitRate)}</td>
          <td>${pct(r.faRate)}</td>
          <td>${pct(r.catchRate)}</td>
          <td>${dp(r.crossDprime)}</td>
          <td>${dp(r.visDprime)}</td>
          <td>${dp(r.audDprime)}</td>
        </tr>`,
        )
        .join('')}
    </tbody>
  `;
  const wrap = document.createElement('div');
  wrap.className = 'swdb-table-wrap';
  wrap.appendChild(table);
  return wrap;
}
