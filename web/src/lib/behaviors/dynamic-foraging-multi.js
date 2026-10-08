// Multi-session behavior reuses the single-session plot and cache identifiers.
import { extractForagingSessionInfo, isForagingAcquisition } from './dynamic-foraging.js';
import { queryForagingSessionsByDates } from './foraging-metadata.js';

export function matchForagingSession(event) {
  if (!isForagingAcquisition(event)) return null;
  const info = extractForagingSessionInfo(event);
  if (!info) return null;
  return {
    ...info,
    assetName: event.data?._assetName ?? event.event ?? '',
    modalities: event.modalities ?? [],
  };
}

export function rowSessionDate(row) {
  const raw = row?.session_date_iso ?? row?.session_date;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.slice(0, 10);
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    const num = Number(raw);
    if (!Number.isFinite(num)) return '';
    // Arrow DATE32 counts days since the epoch; anything larger is milliseconds.
    const ms = Math.abs(num) < 1e6 ? num * 86_400_000 : num;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  return String(raw).slice(0, 10);
}

export function joinSessionMetadata(sessions, rows) {
  const byDateAndSuffix = new Map();
  const byDate = new Map();
  for (const row of rows ?? []) {
    const date = rowSessionDate(row);
    const suffix = row.nwb_suffix == null ? '' : String(row.nwb_suffix);
    byDateAndSuffix.set(`${date}|${suffix}`, row);
    if (!byDate.has(date)) byDate.set(date, row);
  }
  return sessions.map((s) => ({
    ...s,
    meta: byDateAndSuffix.get(`${s.session_date}|${s.nwb_suffix}`)
      ?? byDate.get(s.session_date)
      ?? null,
  }));
}

// Shift each session into a continuous clock without changing the loaded data.
export function concatenateSessions(loaded) {
  const data = { trials: [], rewards: { t: [], side: [] }, sessionStarts: [], sessionEndS: 0 };
  for (const { session, data: source } of loaded) {
    const offset = data.sessionEndS;
    const end = offset + source.sessionEndS;
    data.sessionStarts.push({ t: offset, label: session.session_date });
    for (const trial of source.trials) {
      data.trials.push({
        ...trial,
        goCue_t: Number.isFinite(trial.goCue_t) ? trial.goCue_t + offset : trial.goCue_t,
        session: offset,
        sessionEnd_t: end,
      });
    }
    for (let i = 0; i < (source.rewards?.t.length ?? 0); i++) {
      data.rewards.t.push(source.rewards.t[i] + offset);
      data.rewards.side.push(source.rewards.side[i]);
    }
    data.sessionEndS = end;
  }
  return data;
}

function message(text) {
  const el = document.createElement('p');
  el.className = 'detail-placeholder';
  el.textContent = text;
  return el;
}

function buildBehaviorPlots(sessions, context = {}) {
  if (!context.coordinator) return message('No data connection available.');
  const root = document.createElement('div');
  const label = document.createElement('label');
  label.className = 'multi-session-layout';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  label.append(toggle, ' Fixed width per session');
  const plots = document.createElement('div');
  plots.className = 'df-multi-plots';
  plots.append(message('Loading sessions…'));
  root.append(label, plots);

  const loaded = [];
  const failures = [];
  let createProbPlot;
  let disposers = [];
  let disposed = false;
  const stopped = () => disposed || context.signal?.aborted;
  const clearPlots = () => {
    for (const dispose of disposers) dispose();
    disposers = [];
    plots.replaceChildren();
  };
  const render = () => {
    if (stopped() || !createProbPlot) return;
    clearPlots();
    plots.classList.toggle('df-multi-plots--fixed', toggle.checked);
    const entries = toggle.checked ? loaded : loaded.length ? [{ data: concatenateSessions(loaded) }] : [];
    for (const { session, data } of entries) {
      const card = document.createElement('div');
      card.className = 'df-multi-plot-card';
      if (session) {
        const caption = document.createElement('div');
        caption.className = 'df-multi-figure-caption';
        caption.textContent = session.session_date;
        card.append(caption);
      }
      const plot = createProbPlot(data, { minPlotW: 120 });
      disposers.push(plot.dispose);
      card.append(plot.element);
      plots.append(card);
    }
    for (const session of failures) plots.append(message(`${session.session_date}: session data unavailable.`));
  };
  toggle.addEventListener('change', render);
  root._dispose = () => { disposed = true; clearPlots(); };

  (async () => {
    const { loadDfSession } = await import('../../dynamic_foraging/data-loader.js');
    if (stopped()) return;
    ({ createProbPlot } = await import('../../dynamic_foraging/prob-plot.js'));
    if (stopped()) return;
    // Serial reads reuse DuckDB's cached ranges in the per-subject parquet files.
    for (const session of sessions) {
      if (stopped()) return;
      try {
        const data = await loadDfSession(context.coordinator, {
          subjectId: session.subject_id,
          sessionDate: session.session_date,
          nwbSuffix: session.meta?.nwb_suffix ?? session.nwb_suffix,
          signal: context.signal,
        });
        if (stopped()) return;
        loaded.push({ session, data });
      } catch (err) {
        if (stopped()) return;
        console.warn('[MultiSession] behavior load failed:', err);
        failures.push(session);
      }
    }
    render();
  })().catch((err) => {
    if (stopped()) return;
    console.warn('[MultiSession] behavior plots failed:', err);
    clearPlots();
    plots.append(message('Behavior plots unavailable.'));
  });
  return root;
}

export const dynamicForagingProvider = {
  key: 'dynamic_foraging',
  label: 'dynamic foraging',
  matchSession: matchForagingSession,
  async enrich(sessions, context = {}) {
    if (!context.coordinator) return sessions;
    const rows = await queryForagingSessionsByDates(
      context.coordinator, context.subjectId ?? sessions[0].subject_id,
      sessions.map((session) => session.session_date),
    );
    return joinSessionMetadata(sessions, rows);
  },
  sections: [{ key: 'behavior', title: 'Behavior', build: buildBehaviorPlots }],
};
