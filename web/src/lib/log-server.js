/**
 * log-server.js — Client for the eng-logtools MySQL acquisition_report logs.
 *
 * Fetches "Acquisition Report Generated" events from the internal MySQL log
 * server via the docdb-proxy /log-server endpoint. Credentials are passed
 * through on every request; nothing is cached server-side.
 */

export const LOG_SERVER_BASE = '/log-server';
export const LOG_SERVER_TABLES = ['last_2week', 'last_2month', 'last_year', 'log_server'];

export function pickTableForRange(startIso, endIso) {
  const now = Date.now();
  const startMs = startIso ? new Date(startIso).getTime() : now;
  const days = Math.max(0, (now - startMs) / 86400000);
  if (days <= 14) return 'last_2week';
  if (days <= 62) return 'last_2month';
  if (days <= 366) return 'last_year';
  return 'log_server';
}

export function quarterDateRange(quarterLabel) {
  const m = /^(\d{4})-Q([1-4])$/.exec(quarterLabel ?? '');
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const q = parseInt(m[2], 10);
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 1));
  const fmt = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { startDate: fmt(start), endDate: fmt(end) };
}

export async function fetchAcquisitionReports({ user, password, table, startDate, endDate, signal } = {}) {
  const res = await fetch(`${LOG_SERVER_BASE}/acquisition-reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password, table, startDate, endDate }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const _INSTRUMENT_NAME_MAP = {};

export function normalizeLogInstrument(addrInstrument, learnedMap) {
  if (!addrInstrument) return '';
  if (learnedMap && learnedMap[addrInstrument]) return learnedMap[addrInstrument];
  return _INSTRUMENT_NAME_MAP[addrInstrument] ?? addrInstrument;
}

export function parseLogTimestamp(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(String(s).trim());
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const iso = `${m[1]}T${m[2]}Z`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function logRowToSession(logRow, options = {}) {
  const fields = logRow?.fields ?? {};
  const subject = String(fields.MID ?? '').trim() || null;
  const sessionId = String(fields.OphysSessionID ?? '').trim() || null;
  const acqStart = parseLogTimestamp(fields.Date_timestamp) ?? logRow?.datetime ?? null;
  const uid = String(fields.UID ?? '').trim();
  const experimenters = uid ? [uid] : [];
  return {
    source: 'log',
    subject_id: subject,
    acquisition_start_time: acqStart,
    acquisition_end_time: null,
    project_name: '',
    instrument_id: normalizeLogInstrument(logRow?.instrument_id ?? '', options.instrumentMap),
    experimenters,
    modalities: ['behavior'],
    genotype: '',
    name: sessionId ? `log_${sessionId}` : `log_${acqStart ?? Math.random()}`,
    location: '',
    log_session_id: sessionId,
    log_stimulus: fields.Stimulus ?? '',
    log_report_status: fields['Report Status'] ?? '',
    log_client_address: logRow?.client_address ?? '',
    log_datetime: logRow?.datetime ?? null,
  };
}

export function learnInstrumentMap(existingRows, logRows) {
  const prefixes = new Set();
  for (const lr of logRows) {
    const raw = String(lr?.instrument_id ?? '').trim();
    if (raw) prefixes.add(raw);
  }
  const map = {};
  for (const prefix of prefixes) {
    const counts = new Map();
    for (const r of existingRows) {
      const inst = String(r.instrument_id ?? '');
      if (inst && inst.toUpperCase().includes(prefix.toUpperCase())) {
        counts.set(inst, (counts.get(inst) ?? 0) + 1);
      }
    }
    let best = null;
    let bestN = 0;
    for (const [k, v] of counts) {
      if (v > bestN) { best = k; bestN = v; }
    }
    if (best) map[prefix] = best;
  }
  return map;
}

function _sameDayUtc(aIso, bIso) {
  if (!aIso || !bIso) return false;
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return false;
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

export function mergeLogSessions(existingRows, logSessions) {
  const bySubject = new Map();
  for (const r of existingRows) {
    const key = String(r.subject_id ?? '').trim();
    if (!key) continue;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(r);
  }
  const nameSet = new Set(
    existingRows
      .map((r) => String(r.name ?? ''))
      .filter(Boolean),
  );

  const added = [];
  let matched = 0;
  for (const log of logSessions) {
    const subj = String(log.subject_id ?? '').trim();
    let isMatch = false;
    if (log.log_session_id && [...nameSet].some((n) => n.includes(log.log_session_id))) {
      isMatch = true;
    }
    if (!isMatch && subj) {
      const candidates = bySubject.get(subj) ?? [];
      for (const c of candidates) {
        if (_sameDayUtc(c.acquisition_start_time, log.acquisition_start_time)) {
          isMatch = true;
          break;
        }
      }
    }
    if (isMatch) {
      matched++;
    } else {
      added.push(log);
    }
  }
  return { merged: existingRows.concat(added), added, matchedCount: matched };
}
