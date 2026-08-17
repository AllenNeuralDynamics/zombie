/**
 * midi-modal.js — the "Spike Jukebox" mapping popup.
 *
 * Lists well-isolated ("good") units for the current probe using the notebook's
 * firing-rate / RPV / top-K metrics (mapped onto platform_ecephys_units
 * columns), lets the user pick a musical scale + root, auto-assigns each unit a
 * pitch on the scale ladder (with manual override + per-unit audio preview),
 * and hands the resulting mapping back via onApply.
 */

import { queryRows } from '../lib/arrow.js';
import { escHtml } from '../lib/utils.js';
import { UNIT_SELECTION, SCALES, SYNTH } from './midi-config.js';
import { scaleLadder, midiName } from './midi-sonifier.js';

const NOTE_MIN = 24; // C1
const NOTE_MAX = 96; // C7

function esc(s) { return String(s).replace(/'/g, "''"); }

const SCALE_LABELS = {
  chromatic: 'Chromatic', major: 'Major (Ionian)', minor: 'Minor (Aeolian)',
  dorian: 'Dorian', major_pentatonic: 'Major pentatonic',
  minor_pentatonic: 'Minor pentatonic', blues: 'Blues',
  japanese: 'Japanese (Hirajoshi)', ethiopian: 'Ethiopian (Tizita)',
};

const ROOT_OPTIONS = [36, 40, 43, 48, 52, 55, 60]; // C2 E2 G2 C3 E3 G3 C4

function buildCandidateSql(unitsUrl, probe, sel) {
  const conds = [`device_name = '${esc(probe)}'`];
  if (sel.requireDefaultQc) conds.push('default_qc = TRUE');
  if (sel.decoderLabels?.length) {
    conds.push(`decoder_label IN (${sel.decoderLabels.map((l) => `'${esc(l)}'`).join(', ')})`);
  }
  if (sel.minFiringRateHz != null) conds.push(`firing_rate >= ${Number(sel.minFiringRateHz)}`);
  if (sel.maxFiringRateHz != null) conds.push(`firing_rate <= ${Number(sel.maxFiringRateHz)}`);
  if (sel.maxIsiViolationsRatio != null) conds.push(`isi_violations_ratio <= ${Number(sel.maxIsiViolationsRatio)}`);
  if (sel.minPresenceRatio != null) conds.push(`presence_ratio >= ${Number(sel.minPresenceRatio)}`);
  const order = (sel.rankBy?.length ? sel.rankBy : [['num_spikes', 'DESC']])
    .map(([c, d]) => `${c} ${d === 'ASC' ? 'ASC' : 'DESC'}`).join(', ');
  return `
    SELECT unit_name, decoder_label, firing_rate, snr, num_spikes,
           presence_ratio, isi_violations_ratio, depth
    FROM read_parquet('${esc(unitsUrl)}')
    WHERE ${conds.join(' AND ')}
    ORDER BY ${order}
    LIMIT ${Math.max(1, Number(sel.topK) || 12)}`;
}

/**
 * Open the mapping modal.
 *
 * @param {object} opts
 * @param {object} opts.coord      - DuckDB coordinator.
 * @param {string} opts.unitsUrl   - platform_ecephys_units parquet URL.
 * @param {string} opts.probe      - device_name.
 * @param {string} [opts.timbre]   - default oscillator type for this probe.
 * @param {(note:number,timbre:string)=>void} [opts.onPreview] - audition a pitch.
 * @param {(mapping:{units:Array,scale:string,root:number,timbre:string})=>void} opts.onApply
 */
export function openMidiModal(opts) {
  const { coord, unitsUrl, probe, onApply } = opts;
  const timbre = opts.timbre ?? SYNTH.timbres[0];

  const sel = { ...UNIT_SELECTION };
  let scale = SYNTH.defaultScale;
  let root = SYNTH.rootMidi;
  let rows = [];                 // candidate unit rows
  const included = new Set();    // unit_names included
  const noteOverride = new Map();// unit_name -> midi note (manual)

  const backdrop = document.createElement('div');
  backdrop.className = 'midi-modal-backdrop';
  backdrop.innerHTML = `
    <div class="midi-modal" role="dialog" aria-label="Spike Jukebox mapping">
      <div class="midi-modal-head">
        <h3>🎹 Spike Jukebox — map units to pitches</h3>
        <button class="midi-modal-close" type="button" title="Close">✕</button>
      </div>
      <div class="midi-modal-controls">
        <label>Min Hz <input class="mm-minhz" type="number" step="0.1" value="${sel.minFiringRateHz}"></label>
        <label>Max Hz <input class="mm-maxhz" type="number" step="1" value="${sel.maxFiringRateHz}"></label>
        <label>Max ISIv <input class="mm-rpv" type="number" step="0.01" value="${sel.maxIsiViolationsRatio}"></label>
        <label>Top-K <input class="mm-topk" type="number" step="1" value="${sel.topK}"></label>
        <label>Scale
          <select class="mm-scale">
            ${Object.keys(SCALES).map((k) =>
              `<option value="${k}"${k === scale ? ' selected' : ''}>${SCALE_LABELS[k] ?? k}</option>`).join('')}
          </select>
        </label>
        <label>Root
          <select class="mm-root">
            ${ROOT_OPTIONS.map((n) =>
              `<option value="${n}"${n === root ? ' selected' : ''}>${midiName(n)}</option>`).join('')}
          </select>
        </label>
        <button class="mm-refresh" type="button">Refresh units</button>
        <button class="mm-auto" type="button">Auto-assign</button>
      </div>
      <div class="midi-modal-body">
        <p class="mm-status">Loading units…</p>
        <div class="mm-list"></div>
      </div>
      <div class="midi-modal-foot">
        <span class="mm-summary"></span>
        <span class="mm-foot-btns">
          <button class="mm-cancel" type="button">Cancel</button>
          <button class="mm-apply btn-primary" type="button" disabled>Apply &amp; play</button>
        </span>
      </div>
    </div>`;

  const q = (s) => backdrop.querySelector(s);
  const listEl = q('.mm-list');
  const statusEl = q('.mm-status');
  const summaryEl = q('.mm-summary');
  const applyBtn = q('.mm-apply');

  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  q('.midi-modal-close').onclick = close;
  q('.mm-cancel').onclick = close;

  const noteOptions = () => {
    let out = '';
    for (let n = NOTE_MIN; n <= NOTE_MAX; n++) out += `<option value="${n}">${midiName(n)}</option>`;
    return out;
  };

  function assignedNote(unitName, ladderMap) {
    return noteOverride.get(unitName) ?? ladderMap.get(unitName);
  }

  function autoAssign() {
    // Ladder over currently-included units, in list (rank) order.
    const inc = rows.filter((r) => included.has(r.unit_name));
    const ladder = scaleLadder(scale, root, inc.length);
    noteOverride.clear();
    return new Map(inc.map((r, i) => [r.unit_name, ladder[i]]));
  }

  function updateSummary(ladderMap) {
    const n = included.size;
    summaryEl.textContent = n
      ? `${n} unit${n === 1 ? '' : 's'} → ${SCALE_LABELS[scale] ?? scale} from ${midiName(root)} · probe ${probe}`
      : 'No units selected';
    applyBtn.disabled = n === 0;
  }

  function paint() {
    const ladderMap = autoAssign();
    if (rows.length === 0) { listEl.innerHTML = ''; statusEl.textContent = 'No units passed the filters.'; updateSummary(ladderMap); return; }
    statusEl.textContent = `${rows.length} candidate units (top ${sel.topK} by ${sel.rankBy.map((r) => r[0]).join(', ')}).`;
    const head = `<table class="mm-table"><thead><tr>
      <th></th><th>Unit</th><th>Label</th><th class="num">FR</th><th class="num">SNR</th>
      <th class="num">Spikes</th><th class="num">ISIv</th><th class="num">Depth</th>
      <th>Pitch</th><th></th></tr></thead><tbody>`;
    const body = rows.map((r) => {
      const u = r.unit_name;
      const on = included.has(u);
      const note = assignedNote(u, ladderMap);
      return `<tr class="mm-row${on ? ' on' : ''}" data-unit="${escHtml(u)}">
        <td><input type="checkbox" class="mm-inc"${on ? ' checked' : ''}></td>
        <td class="mm-uname" title="${escHtml(u)}">${escHtml(u.slice(0, 8))}</td>
        <td>${escHtml(r.decoder_label ?? '')}</td>
        <td class="num">${Number(r.firing_rate).toFixed(1)}</td>
        <td class="num">${Number(r.snr).toFixed(1)}</td>
        <td class="num">${Number(r.num_spikes).toLocaleString()}</td>
        <td class="num">${Number(r.isi_violations_ratio).toFixed(3)}</td>
        <td class="num">${r.depth == null ? '—' : Math.round(r.depth)}</td>
        <td><select class="mm-note"${on ? '' : ' disabled'}>${noteOptions()}</select></td>
        <td><button class="mm-prev" type="button"${on ? '' : ' disabled'}>▶</button></td>
      </tr>`;
    }).join('');
    listEl.innerHTML = head + body + '</tbody></table>';
    // Set note-select current values.
    for (const tr of listEl.querySelectorAll('.mm-row')) {
      const u = tr.dataset.unit;
      const note = assignedNote(u, ladderMap);
      if (note != null) tr.querySelector('.mm-note').value = String(note);
    }
    updateSummary(ladderMap);
  }

  listEl.addEventListener('change', (e) => {
    const tr = e.target.closest('.mm-row');
    if (!tr) return;
    const u = tr.dataset.unit;
    if (e.target.classList.contains('mm-inc')) {
      if (e.target.checked) included.add(u); else included.delete(u);
      paint();
    } else if (e.target.classList.contains('mm-note')) {
      noteOverride.set(u, Number(e.target.value));
      updateSummary(null);
    }
  });
  listEl.addEventListener('click', (e) => {
    if (!e.target.classList.contains('mm-prev')) return;
    const tr = e.target.closest('.mm-row');
    const note = Number(tr.querySelector('.mm-note').value);
    opts.onPreview?.(note, timbre);
    tr.classList.add('flash');
    setTimeout(() => tr.classList.remove('flash'), 150);
  });

  q('.mm-scale').onchange = (e) => { scale = e.target.value; paint(); };
  q('.mm-root').onchange = (e) => { root = Number(e.target.value); paint(); };
  q('.mm-auto').onclick = () => { noteOverride.clear(); paint(); };

  async function loadUnits() {
    sel.minFiringRateHz = Number(q('.mm-minhz').value);
    sel.maxFiringRateHz = Number(q('.mm-maxhz').value);
    sel.maxIsiViolationsRatio = Number(q('.mm-rpv').value);
    sel.topK = Math.max(1, Number(q('.mm-topk').value) || 12);
    statusEl.textContent = 'Loading units…';
    listEl.innerHTML = '';
    try {
      rows = await queryRows(coord, buildCandidateSql(unitsUrl, probe, sel));
    } catch (err) {
      console.error('[midi-modal] unit query failed', err);
      statusEl.textContent = 'Error loading units.';
      return;
    }
    included.clear();
    for (const r of rows) included.add(r.unit_name); // include all candidates by default
    noteOverride.clear();
    paint();
  }
  q('.mm-refresh').onclick = loadUnits;

  applyBtn.onclick = () => {
    const ladderMap = autoAssign();
    const units = rows
      .filter((r) => included.has(r.unit_name))
      .map((r) => ({ unitName: r.unit_name, note: assignedNote(r.unit_name, ladderMap) }));
    if (!units.length) return;
    onApply({ units, scale, root, timbre });
    close();
  };

  document.body.appendChild(backdrop);
  loadUnits();
  return { close };
}
