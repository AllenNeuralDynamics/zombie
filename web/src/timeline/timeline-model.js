/**
 * timeline/timeline-model.js — pure milestone/latency logic for the asset
 * timeline page.
 *
 * An asset's journey has four consecutive milestones:
 *
 *   acquisition start → acquisition end → upload → processing complete → visible
 *
 * The first three come straight from `asset_basics` (`acquisition_start_time`,
 * `acquisition_end_time`, `created`). "Processing complete" is the newest
 * derived asset produced from the acquisition (resolved through `source_data`).
 * Portal visibility is not recorded anywhere — assets appear in the data portal
 * at the *next* 06:00 Pacific time at or after processing finishes, so it is
 * derived from the processing timestamp (see {@link portalVisibleAt}).
 *
 * Everything here takes and returns epoch milliseconds so it is testable
 * without DuckDB and without a timestamp-parsing layer: the page's SQL emits
 * `epoch_ms(...)` for every timestamp column.
 *
 * @module
 */

/**
 * The four pipeline stages, in the order they occur. `from`/`to` name the
 * milestones each stage spans. Stages carry no colour of their own — the charts
 * colour by whether an asset finished a stage or is still in it, not by which
 * stage it is (see 29-timeline.css).
 */
export const PIPELINE_STAGES = [
  { key: 'acquisition', label: 'Acquisition', from: 'acqStart', to: 'acqEnd' },
  { key: 'upload', label: 'Awaiting upload', from: 'acqEnd', to: 'uploaded' },
  { key: 'processing', label: 'Processing', from: 'uploaded', to: 'processed' },
  { key: 'release', label: 'Awaiting release', from: 'processed', to: 'visible' },
];

/** Stage keys in pipeline order — the fixed fill order for the chart. */
export const STAGE_KEYS = PIPELINE_STAGES.map((s) => s.key);

/** Human labels keyed by stage key. */
export const STAGE_LABELS = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, s.label]));

/** Hour at which processed assets become visible in the data portal. */
export const PORTAL_RELEASE_HOUR = 6;

/**
 * Timezone the release rule runs on — the Allen Institute is in Seattle
 * (Pacific), and the 06:00 release job is scheduled on that clock regardless
 * of where this page is viewed from. The viewer's own timezone must never
 * enter this calculation: someone opening the page from the East Coast or
 * from Europe would otherwise get a different release moment for the exact
 * same processing event, even though only one job actually ran.
 */
const RELEASE_TIMEZONE = 'America/Los_Angeles';

const HOUR_MS = 3600e3;

/**
 * Read a UTC instant's wall-clock date/time in {@link RELEASE_TIMEZONE}.
 *
 * @param {number} utcMs
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number}}
 */
function pacificParts(utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: RELEASE_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl reports midnight as "24" with hour12: false in some engines.
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Convert a {@link RELEASE_TIMEZONE} wall-clock date/time to its epoch ms.
 *
 * There is no direct "construct a UTC instant from a named-timezone wall
 * time" API, so this guesses a UTC instant assuming a fixed offset, checks
 * what wall time that guess actually falls on in the zone, and corrects by
 * the remaining difference. Pacific's DST offset is piecewise-constant, so
 * one correction pass always converges except inside the one skipped/repeated
 * hour at a DST transition, which this rule never lands on (06:00 is never
 * the transition hour for `America/Los_Angeles`).
 *
 * @param {number} year
 * @param {number} month - 1-indexed.
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number} Epoch ms.
 */
function pacificWallTimeToUtcMs(year, month, day, hour, minute) {
  const wantUtcIfNoOffset = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Initial guess: Pacific is UTC-8 (PST) or UTC-7 (PDT); -8h is a safe seed
  // since the correction pass fixes any error from guessing the wrong one.
  let guessMs = wantUtcIfNoOffset + 8 * HOUR_MS;
  const p = pacificParts(guessMs);
  const gotUtcIfNoOffset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  guessMs += wantUtcIfNoOffset - gotUtcIfNoOffset;
  return guessMs;
}

/**
 * The moment an asset becomes visible in the data portal: the *next*
 * occurrence of 06:00 Pacific time at or after processing completed — not
 * "06:00 the day after", which would wait a full extra day for anything that
 * finished processing before 06:00. Processing that finishes at 05:00 Pacific
 * releases at 06:00 the same day (a 1-hour wait); processing that finishes at
 * 07:00 releases at 06:00 the next day (a 23-hour wait). The wait is therefore
 * always in `[0, 24)` hours, never more than a day.
 *
 * @param {number|null|undefined} processedMs - Processing-complete time, epoch ms.
 * @returns {number|null} Epoch ms of portal visibility, or null if not processed.
 */
export function portalVisibleAt(processedMs) {
  if (processedMs == null || !Number.isFinite(processedMs)) return null;
  const p = pacificParts(processedMs);
  // Advance the Pacific calendar date only when processing finished at or
  // after today's 06:00 release moment — otherwise today's own 06:00 is
  // still ahead and is the "next" occurrence. Date.UTC below is used purely
  // as a calendar calculator (day/month/year overflow normalization), not a
  // real timezone conversion.
  const secondsSinceMidnight = p.hour * 3600 + p.minute * 60 + p.second;
  const dayOffset = secondsSinceMidnight <= PORTAL_RELEASE_HOUR * 3600 ? 0 : 1;
  const rolled = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return pacificWallTimeToUtcMs(
    rolled.getUTCFullYear(),
    rolled.getUTCMonth() + 1,
    rolled.getUTCDate(),
    PORTAL_RELEASE_HOUR,
    0,
  );
}

/**
 * Pipeline status of a single asset, given its milestones and the current time.
 *
 * @param {{uploaded: number|null, processed: number|null, visible: number|null}} milestones
 * @param {number} nowMs
 * @returns {'visible'|'pending-release'|'processing'|'uploading'}
 */
export function assetStatus({ uploaded, processed, visible }, nowMs) {
  if (uploaded == null) return 'uploading';
  if (processed == null) return 'processing';
  if (visible != null && visible > nowMs) return 'pending-release';
  return 'visible';
}

/** Labels for the statuses returned by {@link assetStatus}. */
export const STATUS_LABELS = {
  visible: 'Visible in portal',
  'pending-release': 'Awaiting release',
  processing: 'Processing',
  uploading: 'Awaiting upload',
};

/**
 * Build one asset's timeline from a query row.
 *
 * Stage segments are only emitted where both bounding milestones are known and
 * the interval is non-negative. Clocks disagree across systems (an upload
 * record can be stamped a few seconds before the acquisition's own end time),
 * and a negative-width bar would render as a backwards smear, so those
 * segments are dropped rather than clamped — the milestone timestamps in the
 * table still show what happened.
 *
 * The stage the asset is currently *in* (opened but not yet closed, including a
 * release moment still in the future) is reported separately as `pending`, with
 * `hours` measuring elapsed time so far.
 *
 * @param {object} row - One row from the page query (epoch-ms fields).
 * @param {object} [opts]
 * @param {number} [opts.nowMs] - Current time; injectable for tests.
 * @returns {object} Timeline record with milestones, segments and status.
 */
export function buildAssetTimeline(row, { nowMs = Date.now() } = {}) {
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

  const acqStart = num(row.acq_start_ms);
  const acqEnd = num(row.acq_end_ms);
  const uploaded = num(row.uploaded_ms);
  const processed = num(row.processed_ms);
  const visible = portalVisibleAt(processed);

  const milestones = { acqStart, acqEnd, uploaded, processed, visible };

  const segments = [];
  // The stage the asset is *currently* sitting in: the first one whose opening
  // milestone happened but whose closing milestone hasn't. Its "duration" is
  // elapsed-so-far rather than final, so it is kept out of `segments` (which
  // every summary treats as completed durations) and reported separately.
  let pending = null;
  for (const stage of PIPELINE_STAGES) {
    const start = milestones[stage.from];
    const end = milestones[stage.to];
    if (start == null) continue;
    if (end == null || end > nowMs) {
      if (!pending) {
        pending = {
          stage: stage.key,
          label: stage.label,
          start,
          hours: Math.max(0, (nowMs - start) / HOUR_MS),
        };
      }
      continue;
    }
    if (end < start) continue;
    segments.push({
      stage: stage.key,
      label: stage.label,
      start,
      end,
      hours: (end - start) / HOUR_MS,
    });
  }

  const totalHours =
    acqStart != null && visible != null && visible >= acqStart
      ? (visible - acqStart) / HOUR_MS
      : null;

  return {
    name: row.name,
    subjectId: row.subject_id ?? null,
    projectName: row.project_name ?? null,
    modalities: Array.isArray(row.modalities) ? row.modalities : [],
    derivedName: row.derived_name ?? null,
    milestones,
    segments,
    pending,
    totalHours,
    status: assetStatus(milestones, nowMs),
  };
}

/**
 * Offset each timeline's segments so acquisition start sits at hour zero,
 * making per-asset latencies directly comparable regardless of when the
 * acquisition happened.
 *
 * @param {object} timeline - A record from {@link buildAssetTimeline}.
 * @returns {Array<{stage: string, label: string, x1: number, x2: number}>}
 */
export function relativeSegments(timeline) {
  const origin = timeline.milestones.acqStart;
  if (origin == null) return [];
  return timeline.segments.map((s) => ({
    stage: s.stage,
    label: s.label,
    x1: (s.start - origin) / HOUR_MS,
    x2: (s.end - origin) / HOUR_MS,
  }));
}

/**
 * Median of a numeric array. Returns null for an empty list.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Percentile (nearest-rank) of a numeric array. Returns null for an empty list.
 *
 * @param {number[]} values
 * @param {number} p - Percentile in [0, 1].
 * @returns {number|null}
 */
export function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Per-stage latency summary across a set of timelines.
 *
 * @param {object[]} timelines - Records from {@link buildAssetTimeline}.
 * @returns {Array<{stage: string, label: string, n: number, medianHours: number|null, p90Hours: number|null}>}
 */
export function summarizeStages(timelines) {
  return PIPELINE_STAGES.map((stage) => {
    const hours = [];
    for (const t of timelines) {
      const seg = t.segments.find((s) => s.stage === stage.key);
      if (seg) hours.push(seg.hours);
    }
    return {
      stage: stage.key,
      label: stage.label,
      n: hours.length,
      medianHours: median(hours),
      p90Hours: percentile(hours, 0.9),
    };
  });
}

/**
 * Count assets by pipeline status.
 *
 * @param {object[]} timelines
 * @returns {Record<string, number>}
 */
export function countByStatus(timelines) {
  const counts = { visible: 0, 'pending-release': 0, processing: 0, uploading: 0 };
  for (const t of timelines) {
    if (t.status in counts) counts[t.status] += 1;
  }
  return counts;
}

/**
 * Format an hour count for display ("4.2 h", "3.1 d", "18 min").
 *
 * @param {number|null|undefined} hours
 * @returns {string}
 */
export function formatDuration(hours) {
  if (hours == null || !Number.isFinite(hours)) return '—';
  if (hours < 1 / 60) return '<1 min';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}
