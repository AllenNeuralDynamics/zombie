/**
 * swdb/set-view.js — one SWDB set: history on top, session viewer below.
 *
 * Same two-part shape as `/view`: a timeline of the set's history above, and the
 * detail of whatever is selected below. Clicking a dot on the timeline (or a row in
 * the session table) loads that asset into the viewer, and the selection round-trips
 * through `?asset=` so a session is linkable.
 *
 * Viewer panels are built lazily, one per tab, on first activation. That matters
 * here: the behavior panel is a few hundred KB of parquet, but the eye panel reads
 * ~460k frames, so building all tabs up front would make every session load pay for
 * panels the user may never open.
 */

import { escHtml } from '../lib/utils.js';
import { buildAssetsTable } from '../lib/assets-table.js';
import {
  loadSessions,
  loadSwdbDatasetAssets,
  loadSwdbDatasetSummaries,
  loadSwdbDynamicRoutingUnits,
} from './data.js';
import { datasetInfo, setInfo, summariseSets } from './sets.js';
import { createSetTimeline } from './timeline.js';
import { createSwdbBehaviorView } from './behavior-view.js';
import { createSwdbEyeView } from './eye-view.js';
import { createSwdbPerformanceView } from './performance-view.js';
import { createVisualLearningActivityView } from './visual-learning-activity.js';
import { createVisualLearningOverview } from './visual-learning-overview.js';
import { createVisualLearningTaskPlayback } from './visual-learning-playback.js';

/**
 * Build the SWDB set page.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @returns {HTMLElement}
 */
export function createSwdbSetView(coord, metadata) {
  const params = new URLSearchParams(window.location.search);
  const datasetName = params.get('dataset');
  if (datasetName) return createDatasetDetailView(coord, metadata, datasetName);

  const setId = params.get('set') ?? 'dynamic-routing';
  const initialAsset = params.get('asset') ?? null;

  const root = document.createElement('div');
  root.className = 'swdb-set-view';

  const header = document.createElement('section');
  header.className = 'swdb-set-header';
  root.appendChild(header);

  const historySection = buildSection('Set history', true);
  const viewerSection = buildSection('Session viewer', true);
  const neuronOverview = setId === 'dynamic-routing' ? buildNeuronOverview() : null;
  if (neuronOverview) root.appendChild(neuronOverview.element);
  root.appendChild(historySection.details);
  root.appendChild(viewerSection.details);

  viewerSection.body.innerHTML = '<div class="swdb-panel-status">Select a session above.</div>';

  let timeline = null;
  let currentAsset = null;
  let currentViewer = null;
  let sessionsById = new Map();

  function syncUrl() {
    const next = new URLSearchParams();
    next.set('set', setId);
    if (currentAsset) next.set('asset', currentAsset);
    window.history.replaceState(null, '', `${window.location.pathname}?${next}`);
  }

  function selectAsset(assetName) {
    const row = sessionsById.get(assetName);
    if (!row || currentAsset === assetName) return;
    currentAsset = assetName;
    syncUrl();
    timeline?.selectAsset(assetName);
    highlightRow(historySection.body, assetName);
    // Abort the outgoing session's in-flight parquet reads before swapping it out;
    // clicking through the timeline quickly would otherwise leave several
    // sessions' worth of requests running against a table nobody is looking at.
    currentViewer?._dispose?.();
    currentViewer = buildViewer(coord, row);
    viewerSection.body.replaceChildren(currentViewer);
    viewerSection.details.open = true;
  }

  (async () => {
    try {
      const sessions = await loadSessions(coord);
      const sets = summariseSets(sessions);
      const set = sets.find((s) => s.setId === setId);

      if (!set) {
        header.innerHTML = `<h1>${escHtml(setInfo(setId).title)}</h1>`;
        historySection.body.innerHTML =
          `<div class="swdb-panel-status swdb-panel-status--error">No cached assets for set "${escHtml(setId)}".</div>`;
        neuronOverview?.load([]);
        return;
      }

      sessionsById = new Map(set.rows.map((r) => [r.asset_name, r]));
      header.replaceChildren(buildHeader(set));
      neuronOverview?.load(set.rows);

      timeline = createSetTimeline(set.rows, { onSelect: selectAsset });
      historySection.body.replaceChildren(timeline, buildSessionTable(set.rows, selectAsset));

      const first = sessionsById.has(initialAsset) ? initialAsset : null;
      if (first) selectAsset(first);
    } catch (err) {
      historySection.body.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Could not load the SWDB session catalog: ${err.message}`;
      historySection.body.appendChild(msg);
      console.error('[SWDB] set load failed', err);
    }
  })();

  return root;
}

/**
 * Lightweight detail landing page for a published SWDB metadata dataset.
 *
 * Visual Learning is the exception to the usual dataset landing page: its
 * task playback and cell activity panels are coordinated here because their
 * time axes are part of the same exploration.
 */
function createDatasetDetailView(coord, metadata, datasetName) {
  const root = document.createElement('div');
  root.className = 'swdb-set-view';
  const header = document.createElement('section');
  header.className = 'swdb-set-header';
  root.appendChild(header);

  const neuronOverview = datasetName === 'swdb_2026_dynamic_routing'
    ? buildNeuronOverview()
    : null;
  let visualLearningActivity = null;
  let visualLearningPlayback = null;
  const visualLearning = datasetName === 'swdb_2026_visual_learning';
  if (visualLearning) {
    visualLearningActivity = createVisualLearningActivityView(coord, {
      onSelect: (session) => visualLearningPlayback?.select(session, { notify: false }),
    });
    visualLearningPlayback = createVisualLearningTaskPlayback(coord, {
      onSelect: (session) => visualLearningActivity?.select(session, { notify: false }),
      onTimeDomainChange: (domain) => visualLearningActivity?.setTimeDomain(domain),
    });
  }
  const visualLearningOverview = datasetName === 'swdb_2026_visual_learning'
    ? createVisualLearningOverview(coord, {
      onSelect: (session) => {
        visualLearningPlayback?.select(session, { notify: false });
        visualLearningActivity?.select(session, { notify: false });
      },
    })
    : null;
  if (neuronOverview) root.appendChild(neuronOverview.element);
  if (visualLearningOverview) root.appendChild(visualLearningOverview.element);
  if (visualLearningPlayback) root.appendChild(visualLearningPlayback.element);
  if (visualLearningActivity) root.appendChild(visualLearningActivity.element);

  const assetsSection = buildSection('Assets', true);
  root.appendChild(assetsSection.details);
  assetsSection.body.innerHTML = '<div class="swdb-panel-status">Loading assets…</div>';

  (async () => {
    try {
      const summary = (await loadSwdbDatasetSummaries(coord, metadata))
        .find((dataset) => dataset.name === datasetName);
      if (!summary) {
        header.innerHTML = `<h1>${escHtml(datasetInfo(datasetName).title)}</h1>`;
        assetsSection.body.innerHTML =
          `<div class="swdb-panel-status swdb-panel-status--error">No cached SWDB dataset named "${escHtml(datasetName)}".</div>`;
        neuronOverview?.load([]);
        visualLearningPlayback?.load([]);
        visualLearningActivity?.load([]);
        return;
      }

      // The published dataset table is the source of truth for this page. Do
      // not make the optional session catalog a prerequisite: some cache
      // versions publish the dataset membership and its asset metadata without
      // publishing platform_swdb_sessions yet.
      const { assets, sourceMap } = await loadSwdbDatasetAssets(coord, metadata, datasetName);

      const info = datasetInfo(summary.name);
      const datasetSummary = datasetName === 'swdb_2026_visual_learning'
        ? ''
        : `
        <div class="swdb-set-summary">
          <span><strong>${summary.nAssets.toLocaleString()}</strong> assets</span>
          <span><strong>${summary.nSubjects.toLocaleString()}</strong> subjects</span>
          ${summary.firstDate && summary.lastDate
            ? `<span>${escHtml(`${summary.firstDate} → ${summary.lastDate}`)}</span>`
            : ''}
        </div>`;
      header.innerHTML = `
        <a class="swdb-back" href="/swdb">← All SWDB datasets</a>
        <h1>${escHtml(info.title)}</h1>
        ${datasetSummary}
      `;
      neuronOverview?.load(assets.map((asset) => ({
        asset_name: asset.name,
        subject_id: asset.subject_id,
        session_date: asset.acquisition_start_time
          ? String(asset.acquisition_start_time).slice(0, 10)
          : null,
      })));
      visualLearningOverview?.load(assets);
      visualLearningPlayback?.load(assets, sourceMap);
      visualLearningActivity?.load(assets, sourceMap);
      if (assets.length > 0) {
        assetsSection.body.replaceChildren(buildAssetsTable(assets, sourceMap));
      } else {
        const empty = document.createElement('p');
        empty.className = 'swdb-panel-caption';
        empty.textContent = 'No matching asset records are present in asset_basics yet.';
        assetsSection.body.replaceChildren(empty);
      }
    } catch (err) {
      assetsSection.body.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Could not load the SWDB dataset: ${err.message}`;
      assetsSection.body.appendChild(msg);
      console.error('[SWDB] dataset detail load failed', err);
    }
  })();

  return root;
}

// ---------------------------------------------------------------------------
// Header + section scaffold
// ---------------------------------------------------------------------------

function buildHeader(set) {
  const el = document.createElement('div');
  const span = set.firstDate && set.lastDate ? `${set.firstDate} → ${set.lastDate}` : '';
  el.innerHTML = `
    <a class="swdb-back" href="/swdb">← All SWDB sets</a>
    <h1>${escHtml(set.title)}</h1>
    <p class="swdb-set-blurb">${escHtml(set.blurb)}</p>
    <div class="swdb-set-summary">
      <span><strong>${set.nAssets}</strong> assets</span>
      <span><strong>${set.nSubjects}</strong> subjects</span>
      <span><strong>${set.nTrials.toLocaleString()}</strong> trials</span>
      <span><strong>${set.nUnits.toLocaleString()}</strong> units</span>
      <span><strong>${set.totalHours.toFixed(0)}</strong> h recorded</span>
      ${span ? `<span>${escHtml(span)}</span>` : ''}
    </div>
  `;
  return el;
}

function buildSection(title, open) {
  const details = document.createElement('details');
  details.className = 'swdb-section';
  details.open = open;
  const summary = document.createElement('summary');
  summary.className = 'swdb-section-summary';
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'swdb-section-body';
  details.appendChild(summary);
  details.appendChild(body);
  return { details, body };
}

// ---------------------------------------------------------------------------
// Dynamic Routing neuron overview
// ---------------------------------------------------------------------------

function buildNeuronOverview() {
  const section = document.createElement('section');
  section.className = 'swdb-neuron-overview';

  const heading = document.createElement('h2');
  heading.textContent = 'All neuron locations';
  section.appendChild(heading);

  const mount = document.createElement('div');
  mount.className = 'swdb-neuron-viz-mount';
  mount.innerHTML = '<div class="swdb-panel-status">Loading neuron locations…</div>';
  section.appendChild(mount);

  const status = document.createElement('p');
  status.className = 'swdb-neuron-viz-status swdb-panel-caption';
  status.hidden = true;
  section.appendChild(status);

  let controller = null;
  let viewer = null;

  return {
    element: section,
    async load(rows) {
      controller?.abort();
      controller = new AbortController();
      viewer = null;
      mount.innerHTML = '<div class="swdb-panel-status">Loading neuron locations…</div>';
      status.hidden = true;
      try {
        const result = await loadSwdbDynamicRoutingUnits(rows, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.units.length === 0) {
          mount.innerHTML = '<div class="swdb-panel-status">No CCF neuron locations are available.</div>';
          if (result.failedAssets.length) {
            status.textContent = `Could not read ${result.failedAssets.length} acquisition${result.failedAssets.length === 1 ? '' : 's'}.`;
            status.hidden = false;
          }
          return;
        }

        const { createEphysUnitViz3D } = await import('../dynamic_routing_raster/unit-viz-3d.js');
        if (controller.signal.aborted) return;
        viewer = createEphysUnitViz3D({
          units: result.units,
          colorBy: 'acquisition',
          showStructures: false,
          className: 'swdb-neuron-viz',
        });
        mount.replaceChildren(viewer);
        const acquisitions = new Set(result.units.map((unit) => unit.acquisition)).size;
        const failureNote = result.failedAssets.length
          ? ` ${result.failedAssets.length} acquisition${result.failedAssets.length === 1 ? '' : 's'} could not be read.`
          : '';
        status.textContent = `${result.units.length.toLocaleString()} neuron locations from `
          + `${acquisitions} acquisition${acquisitions === 1 ? '' : 's'}.${failureNote}`;
        status.hidden = false;
      } catch (error) {
        if (controller.signal.aborted) return;
        mount.innerHTML = '<div class="swdb-panel-status swdb-panel-status--error">Could not load neuron locations.</div>';
        console.error('[SWDB] neuron overview load failed', error);
      }
    },
    dispose() {
      controller?.abort();
      viewer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Session table
// ---------------------------------------------------------------------------

function buildSessionTable(rows, onSelect) {
  const wrap = document.createElement('div');
  wrap.className = 'swdb-table-wrap';

  const table = document.createElement('table');
  table.className = 'swdb-table swdb-session-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th><th>Subject</th><th>Trials</th><th>Blocks</th><th>Licks</th>
        <th>Units</th><th>Duration</th><th>Modalities</th><th></th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(buildSessionRow).join('')}
    </tbody>
  `;

  table.querySelectorAll('tbody tr').forEach((tr) => {
    tr.addEventListener('click', (ev) => {
      // Let the subject link navigate instead of selecting the row.
      if (ev.target.closest('a')) return;
      onSelect(tr.dataset.asset);
    });
  });

  wrap.appendChild(table);
  return wrap;
}

function buildSessionRow(r) {
  const hours = (Number(r.session_duration_s) || 0) / 3600;
  const flags = [
    r.has_eye_tracking ? 'eye' : null,
    r.has_units ? 'units' : null,
    r.has_optotagging ? 'opto' : null,
    r.has_rf_mapping ? 'RF' : null,
  ].filter(Boolean);
  return `
    <tr data-asset="${escHtml(r.asset_name)}">
      <td>${escHtml(r.session_date ?? '–')}</td>
      <td>${escHtml(String(r.subject_id))}</td>
      <td>${Number(r.n_trials).toLocaleString()}</td>
      <td>${r.n_blocks}</td>
      <td>${Number(r.n_licks).toLocaleString()}</td>
      <td>${Number(r.n_units).toLocaleString()}</td>
      <td>${hours.toFixed(1)} h</td>
      <td>${flags.map((f) => `<span class="swdb-chip swdb-chip--sm">${escHtml(f)}</span>`).join('')}</td>
      <td><a href="/view?subject_id=${encodeURIComponent(r.subject_id)}" title="Open the subject page">subject →</a></td>
    </tr>
  `;
}

function highlightRow(container, assetName) {
  container.querySelectorAll('tbody tr').forEach((tr) => {
    tr.classList.toggle('swdb-row--selected', tr.dataset.asset === assetName);
  });
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

function buildViewer(coord, row) {
  const wrap = document.createElement('div');
  wrap.className = 'swdb-viewer';
  wrap.appendChild(buildAssetHeader(row));

  const asset = row.asset_name;
  const tabs = createTabs([
      {
        label: 'Behavior',
        build: () => createSwdbBehaviorView(coord, asset, { subjectId: row.subject_id }),
      },
      {
        label: 'Performance',
        build: () => createSwdbPerformanceView(coord, asset),
      },
      {
        label: 'Eye tracking',
        build: () => createSwdbEyeView(coord, asset),
        enabled: !!row.has_eye_tracking,
      },
      {
        label: 'Session',
        build: () => buildSessionDetail(row),
      },
  ]);
  wrap.appendChild(tabs);
  wrap._dispose = () => tabs._disposeAll();
  return wrap;
}

function buildAssetHeader(row) {
  const el = document.createElement('div');
  el.className = 'swdb-asset-header';
  el.innerHTML = `
    <div class="swdb-asset-name">${escHtml(row.asset_name)}</div>
    <div class="swdb-asset-meta">
      subject
      <a href="/view?subject_id=${encodeURIComponent(row.subject_id)}">${escHtml(String(row.subject_id))}</a>
      · ${escHtml(row.session_date ?? '')}
    </div>
  `;
  return el;
}

function buildSessionDetail(row) {
  const el = document.createElement('div');
  el.className = 'swdb-session-detail';

  let epochs = [];
  try {
    epochs = JSON.parse(row.epochs ?? '[]');
  } catch {
    epochs = [];
  }

  const fields = [
    ['Asset', row.asset_name],
    ['Location', row.location],
    ['Subject', row.subject_id],
    ['Session date', row.session_date],
    ['Session start', row.session_start_time],
    ['Duration', `${((Number(row.session_duration_s) || 0) / 3600).toFixed(2)} h`],
    ['Trials', Number(row.n_trials).toLocaleString()],
    ['Blocks', row.n_blocks],
    ['Licks', Number(row.n_licks).toLocaleString()],
    ['Rewards', Number(row.n_rewards).toLocaleString()],
    ['Optotagging trials', Number(row.n_opto_trials).toLocaleString()],
    ['Visual RF trials', Number(row.n_vis_rf_trials).toLocaleString()],
    ['Auditory RF trials', Number(row.n_aud_rf_trials).toLocaleString()],
    ['Eye-camera frames', Number(row.n_eye_frames).toLocaleString()],
    ['Running samples', Number(row.n_running_samples).toLocaleString()],
    ['Sorted units', Number(row.n_units).toLocaleString()],
  ];

  el.innerHTML = `
    <dl class="swdb-kv">
      ${fields
        .map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(String(v ?? '–'))}</dd></div>`)
        .join('')}
    </dl>
    <div class="swdb-epoch-list">
      <h3>Session epochs</h3>
      <ol>${epochs.map((e) => `<li>${escHtml(String(e))}</li>`).join('')}</ol>
    </div>
    <p class="swdb-panel-caption">
      All times in the cached tables are seconds from <code>session_start_time</code>.
      Sorted units are present in the source NWB but are not yet surfaced in this viewer.
    </p>
  `;
  return el;
}

/**
 * Minimal lazy tab widget.
 *
 * Local to the SWDB dashboard rather than shared: the equivalent in
 * `subject/details.js` is module-private and eagerly builds its panels, whereas
 * these panels must be built on first activation to avoid loading every modality
 * for every session.
 *
 * @param {{label: string, build: () => HTMLElement, enabled?: boolean}[]} tabs
 * @returns {HTMLElement}
 */
export function createTabs(tabs) {
  const root = document.createElement('div');
  root.className = 'swdb-tabs';

  const bar = document.createElement('div');
  bar.className = 'swdb-tab-bar';
  const panel = document.createElement('div');
  panel.className = 'swdb-tab-panel';

  const built = new Map();
  const usable = tabs.filter((t) => t.enabled !== false);

  function activate(tab) {
    bar.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('swdb-tab--active', b.dataset.label === tab.label);
    });
    if (!built.has(tab.label)) built.set(tab.label, tab.build());
    panel.replaceChildren(built.get(tab.label));
  }

  for (const tab of usable) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swdb-tab';
    btn.dataset.label = tab.label;
    btn.textContent = tab.label;
    btn.addEventListener('click', () => activate(tab));
    bar.appendChild(btn);
  }

  root.appendChild(bar);
  root.appendChild(panel);
  if (usable.length > 0) activate(usable[0]);

  // Panels own AbortControllers for their parquet reads; only the ones actually
  // built need disposing.
  root._disposeAll = () => {
    for (const el of built.values()) el?._dispose?.();
    built.clear();
  };
  return root;
}
