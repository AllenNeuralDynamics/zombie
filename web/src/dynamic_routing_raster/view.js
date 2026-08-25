/** Dynamic Routing context/stimulus-aligned ecephys raster viewer. */

import * as Plot from '@observablehq/plot';
import {
  buildConditionPanels,
  buildRasterRows,
  loadRasterSession,
} from './data.js';

const DEFAULT_PRE = -1;
const DEFAULT_POST = 2;

function finite(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sortUnits(units) {
  return [...units].sort((a, b) => {
    const aRate = Number.isFinite(a.firingRate) ? a.firingRate : -Infinity;
    const bRate = Number.isFinite(b.firingRate) ? b.firingRate : -Infinity;
    return bRate - aRate
      || String(a.deviceName).localeCompare(String(b.deviceName), undefined, { numeric: true })
      || String(a.unitName).localeCompare(String(b.unitName), undefined, { numeric: true });
  });
}

function deviceKey(unit) {
  return `${unit.experiment ?? 'experiment'}::${unit.deviceName ?? 'device'}`;
}

function unitLabel(unit) {
  const stats = [];
  if (unit.decoderLabel) stats.push(unit.decoderLabel);
  if (Number.isFinite(unit.firingRate)) stats.push(`${unit.firingRate.toFixed(1)} Hz`);
  if (Number.isFinite(unit.numSpikes)) stats.push(`${unit.numSpikes.toLocaleString()} spikes`);
  return `${unit.unitName}${stats.length ? ` (${stats.join(', ')})` : ''}`;
}

function buildProbeOptions(select, units, selectedKey) {
  const probes = new Map();
  for (const unit of units) {
    const key = deviceKey(unit);
    if (!probes.has(key)) {
      probes.set(key, {
        key,
        label: `${unit.experiment ?? 'experiment'} / ${unit.deviceName ?? 'device'}`,
      });
    }
  }
  const sorted = [...probes.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }));
  select.replaceChildren();
  for (const probe of sorted) {
    const option = document.createElement('option');
    option.value = probe.key;
    option.textContent = probe.label;
    option.selected = probe.key === selectedKey;
    select.appendChild(option);
  }
  const preferred = sorted.find((probe) => probe.key === selectedKey) ?? sorted[0] ?? null;
  if (preferred) select.value = preferred.key;
  return { selected: preferred, count: sorted.length };
}

function buildUnitOptions(select, units, selectedKey, selectedDeviceKey) {
  select.replaceChildren();
  const sorted = sortUnits(units.filter((unit) => (
    !selectedDeviceKey || deviceKey(unit) === selectedDeviceKey
  )));
  for (const unit of sorted) {
    const option = document.createElement('option');
    option.value = unit.key;
    option.textContent = unitLabel(unit);
    option.selected = unit.key === selectedKey;
    select.appendChild(option);
  }
  const requested = sorted.find((unit) => unit.key === selectedKey);
  const preferred = requested ?? sorted.find((unit) => unit.qc) ?? sorted[0] ?? null;
  if (preferred) select.value = preferred.key;
  return preferred;
}

function makePlot(trials, spikes, pre, post, includeCatch) {
  const panels = buildConditionPanels(trials, { includeCatch });
  const rows = [];
  const groups = [];
  let rowOffset = 0;
  for (const panel of panels) {
    const start = rowOffset;
    rows.push(...buildRasterRows(spikes, panel.trials, pre, post, rowOffset));
    rowOffset += panel.trials.length;
    groups.push({
      ...panel,
      start,
      end: rowOffset - 1,
      midpoint: start + Math.max(0, panel.trials.length - 1) / 2,
    });
  }
  const sections = [];
  for (const group of groups) {
    const key = group.context ?? 'catch';
    const previous = sections.at(-1);
    if (previous?.key === key) {
      previous.end = group.end;
      previous.midpoint = (previous.start + previous.end) / 2;
    } else {
      sections.push({
        key,
        label: key === 'vis' ? 'VIS context' : key === 'aud' ? 'AUD context' : 'Catch trials',
        start: group.start,
        end: group.end,
        midpoint: group.midpoint,
      });
    }
  }
  const groupTicks = new Map(groups.map((group) => [
    group.midpoint,
    group.label.split(' · ').at(-1),
  ]));
  const groupBoundaries = groups.slice(1).map((group) => group.start - 0.5);
  const sectionBoundaries = sections.slice(1).map((section) => section.start - 0.5);
  const n = Math.max(1, rowOffset);
  return Plot.plot({
    width: 980,
    height: Math.max(300, Math.min(735, 85 + n * 1.25)),
    marginLeft: 178,
    marginRight: 18,
    marginTop: 18,
    marginBottom: 30,
    x: { domain: [pre, post], label: 'time from stimulus onset (s)', ticks: 5, grid: true },
    y: {
      domain: [-0.5, Math.max(0.5, n - 0.5)],
      label: 'stimulus type',
      reverse: true,
      ticks: groups.map((group) => group.midpoint),
      tickFormat: (value) => groupTicks.get(value) ?? '',
    },
    marks: [
      Plot.ruleX([0], { stroke: '#111827', strokeWidth: 1.2 }),
      Plot.ruleY(groupBoundaries, { stroke: '#cbd5e1', strokeWidth: 0.8 }),
      Plot.ruleY(sectionBoundaries, { stroke: '#475569', strokeWidth: 1.5 }),
      Plot.textY(sections, {
        y: 'midpoint',
        text: 'label',
        frameAnchor: 'left',
        rotate: -90,
        dx: -125,
        textAnchor: 'middle',
        lineAnchor: 'middle',
        fill: '#475569',
        stroke: 'none',
        fontWeight: 700,
        fontSize: 10,
      }),
      Plot.ruleX(rows, {
        x: 'relative',
        y1: (d) => d.row - 0.35,
        y2: (d) => d.row + 0.35,
        stroke: '#000',
        strokeWidth: 1,
      }),
    ],
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
  });
}

/**
 * Create the raster section that belongs in the /view Data tab.
 *
 * The acquisition event supplies the asset name; the loader follows its
 * source_data relationship when the timeline asset is raw but the public
 * NWB-Zarr is a derived ecephys asset.
 */
export function createDynamicRoutingRasterSection(coord, assetName) {
  const container = document.createElement('div');
  container.className = 'dynamic-routing-raster-view dynamic-routing-raster-section';

  let currentSession = null;
  let currentUnit = null;
  let generation = 0;
  let spikeController = null;

  container.innerHTML = `
    <div class="dr-raster-layout">
      <aside class="dr-raster-settings">
        <section class="dr-raster-controls" aria-label="Raster controls">
          <label class="dr-raster-probe-control">Probe / shank
            <select class="dr-raster-probe" disabled><option>Loading probes…</option></select>
          </label>
          <label>Neuron
            <select class="dr-raster-unit" disabled><option>Loading units…</option></select>
          </label>
          <label>Pre (s)
            <input class="dr-raster-pre" type="number" step="0.25" value="${DEFAULT_PRE}" />
          </label>
          <label>Post (s)
            <input class="dr-raster-post" type="number" step="0.25" value="${DEFAULT_POST}" />
          </label>
          <label class="dr-raster-check"><input class="dr-raster-catch" type="checkbox" /> Show catch trials</label>
        </section>
        <p class="dr-raster-status" role="status">Loading the selected asset…</p>
      </aside>
      <section class="dr-raster-raster" aria-live="polite"></section>
    </div>
  `;

  const probeControl = container.querySelector('.dr-raster-probe-control');
  const probeSelect = container.querySelector('.dr-raster-probe');
  const unitSelect = container.querySelector('.dr-raster-unit');
  const preInput = container.querySelector('.dr-raster-pre');
  const postInput = container.querySelector('.dr-raster-post');
  const catchInput = container.querySelector('.dr-raster-catch');
  const status = container.querySelector('.dr-raster-status');
  const rasterMount = container.querySelector('.dr-raster-raster');

  function setStatus(message, error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('is-error', error);
  }

  async function renderSelectedUnit() {
    if (!currentSession || !currentUnit) return;
    spikeController?.abort();
    spikeController = new AbortController();
    const localGeneration = ++generation;
    const pre = finite(preInput.value, DEFAULT_PRE);
    const post = Math.max(pre + 0.25, finite(postInput.value, DEFAULT_POST));
    preInput.value = String(pre);
    postInput.value = String(post);
    setStatus(`Loading spikes for ${currentUnit.deviceName} · ${currentUnit.unitName}…`);
    try {
      const spikes = await currentSession.loadSpikes(currentUnit, { signal: spikeController.signal });
      if (localGeneration !== generation) return;
      const panels = buildConditionPanels(currentSession.trials, { includeCatch: catchInput.checked });
      if (!panels.length) {
        const empty = document.createElement('p');
        empty.className = 'dr-raster-empty';
        empty.textContent = 'No trial conditions are available.';
        rasterMount.replaceChildren(empty);
      } else {
        rasterMount.replaceChildren(makePlot(
          currentSession.trials, spikes, pre, post, catchInput.checked,
        ));
      }
      setStatus('');
    } catch (error) {
      if (error?.message === 'aborted' || spikeController.signal.aborted) return;
      console.error('[dynamic-routing-raster] spike load failed', error);
      setStatus(`Could not load spikes: ${error?.message ?? error}`, true);
      rasterMount.replaceChildren();
    }
  }

  async function loadAsset() {
    const asset = String(assetName ?? '').trim();
    if (!asset) { setStatus('No acquisition asset is available.', true); return; }
    unitSelect.disabled = true;
    probeSelect.disabled = true;
    rasterMount.replaceChildren();
    setStatus(`Loading trials and unit catalog for ${asset}…`);
    try {
      currentSession = await loadRasterSession(coord, asset);
      const preferredUnit = sortUnits(currentSession.units).find((unit) => unit.qc)
        ?? sortUnits(currentSession.units)[0]
        ?? null;
      const probes = buildProbeOptions(
        probeSelect,
        currentSession.units,
        preferredUnit ? deviceKey(preferredUnit) : null,
      );
      probeControl.hidden = probes.count < 2;
      probeSelect.disabled = !probes.selected;
      currentUnit = buildUnitOptions(
        unitSelect,
        currentSession.units,
        preferredUnit?.key ?? null,
        probeSelect.value,
      );
      unitSelect.disabled = !currentUnit;
      if (!currentUnit) {
        setStatus('The asset loaded, but no units were available.', true);
      } else {
        await renderSelectedUnit();
      }
    } catch (error) {
      console.error('[dynamic-routing-raster] asset load failed', error);
      setStatus(`Could not load asset: ${error?.message ?? error}`, true);
    }
  }

  probeSelect.addEventListener('change', () => {
    currentUnit = buildUnitOptions(unitSelect, currentSession?.units ?? [], null, probeSelect.value);
    unitSelect.disabled = !currentUnit;
    renderSelectedUnit();
  });

  unitSelect.addEventListener('change', () => {
    currentUnit = currentSession?.units.find((unit) => unit.key === unitSelect.value) ?? null;
    renderSelectedUnit();
  });
  preInput.addEventListener('change', () => renderSelectedUnit());
  postInput.addEventListener('change', () => renderSelectedUnit());
  catchInput.addEventListener('change', () => renderSelectedUnit());

  loadAsset();
  return container;
}
