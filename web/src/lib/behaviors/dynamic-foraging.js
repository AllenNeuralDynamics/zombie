/**
 * dynamic-foraging.js — Foraging session detail panel.
 *
 * Renders a metadata card + pre-rendered choice_history PNG for a given
 * dynamic foraging session. Data comes from the `platform_dynamic_foraging_sessions`
 * DuckDB table (session-level metadata) and the public S3 bucket
 * `aind-behavior-data` (pre-rendered images).
 */

import { queryForagingSession } from './foraging-metadata.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const S3_BASE = 'https://aind-behavior-data.s3.us-west-2.amazonaws.com/foraging_nwb_bonsai_processed';

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

/**
 * Build the public S3 URL for a session's choice_history.png.
 *
 * Path pattern:
 *   {base}/{subject}_{date}_{suffix}/{subject}_{date}_{suffix}_choice_history.png
 *
 * If nwb_suffix is 0, NaN, or falsy, it is omitted (matching upstream logic).
 */
export function buildChoiceHistoryUrl(subjectId, sessionDate, nwbSuffix) {
  const suffix = nwbSuffix && !isNaN(nwbSuffix) && Number(nwbSuffix) !== 0
    ? `_${nwbSuffix}`
    : '';
  const key = `${subjectId}_${sessionDate}${suffix}`;
  return `${S3_BASE}/${key}/${key}_choice_history.png`;
}

// ---------------------------------------------------------------------------
// Metadata card builder
// ---------------------------------------------------------------------------

function formatEff(val) {
  if (val == null || isNaN(val)) return 'N/A';
  return Number(val).toFixed(3);
}

function buildMetadataHtml(meta) {
  if (!meta) return '<p class="detail-placeholder">No foraging metadata available.</p>';

  const stage = meta.current_stage_actual ?? 'Unknown';
  const stageColor = stage.includes('FINAL') || stage === 'GRADUATED' ? '#1D8649' : '#d97706';

  return `
    <div class="foraging-meta-card">
      <dl>
        <dt>Subject</dt><dd>${meta.subject_id ?? 'Unknown'}</dd>
        <dt>Date</dt><dd>${meta.session_date ?? 'Unknown'}</dd>
        <dt>Trainer / Rig</dt><dd>${meta.trainer ?? 'Unknown'} @ ${meta.rig ?? 'Unknown'}</dd>
        <dt>Curriculum</dt><dd>${meta.curriculum_name ?? 'Unknown'} v${meta.curriculum_version ?? '?'}</dd>
        <dt>Stage</dt><dd style="color: ${stageColor}; font-weight: bold;">${stage}</dd>
      </dl>
      <hr>
      <dl>
        <dt>Task</dt><dd>${meta.task ?? 'Unknown'}</dd>
        <dt>Foraging Efficiency</dt><dd><strong>${formatEff(meta.foraging_eff)}</strong></dd>
        <dt>Finished Trials</dt><dd><strong>${meta.finished_trials ?? 'N/A'}</strong> / ${meta.total_trials ?? 'N/A'}</dd>
        <dt>Finished Rate</dt><dd>${formatEff(meta.finished_rate)}</dd>
        <dt>Bias (naive)</dt><dd>${formatEff(meta.bias_naive)}</dd>
      </dl>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main panel builder
// ---------------------------------------------------------------------------

/**
 * Create the foraging session detail panel.
 *
 * @param {{ subject_id: string, session_date: string, nwb_suffix?: number|string }} sessionInfo
 * @param {object|null} metadata - Pre-fetched metadata row (if null, fetched via coordinator)
 * @param {object|null} coordinator - Mosaic coordinator (for querying metadata if not provided)
 * @returns {HTMLElement}
 */
export function createForagingSessionDetail(sessionInfo, metadata = null, coordinator = null) {
  const container = document.createElement('div');
  container.className = 'foraging-session-detail';

  // Metadata section (may update async)
  const metaEl = document.createElement('div');
  metaEl.className = 'foraging-meta-section';
  container.appendChild(metaEl);

  if (metadata) {
    metaEl.innerHTML = buildMetadataHtml(metadata);
    _appendImage(container, sessionInfo.subject_id, sessionInfo.session_date, metadata.nwb_suffix ?? sessionInfo.nwb_suffix);
  } else if (coordinator) {
    metaEl.innerHTML = '<p class="subject-loading">Loading foraging metadata…</p>';
    queryForagingSession(coordinator, sessionInfo.subject_id, sessionInfo.session_date).then((meta) => {
      if (meta) {
        metaEl.innerHTML = buildMetadataHtml(meta);
        _appendImage(container, sessionInfo.subject_id, sessionInfo.session_date, meta.nwb_suffix);
      } else {
        metaEl.innerHTML = '<p class="detail-placeholder">No foraging session data found for this date.</p>';
        _appendImage(container, sessionInfo.subject_id, sessionInfo.session_date, sessionInfo.nwb_suffix);
      }
    });
  } else {
    metaEl.innerHTML = buildMetadataHtml(null);
    _appendImage(container, sessionInfo.subject_id, sessionInfo.session_date, sessionInfo.nwb_suffix);
  }

  return container;
}

function _appendImage(container, subjectId, sessionDate, nwbSuffix) {
  const imgWrapper = document.createElement('div');
  imgWrapper.className = 'foraging-plot-section';

  const url = buildChoiceHistoryUrl(subjectId, sessionDate, nwbSuffix);

  const img = document.createElement('img');
  img.src = url;
  img.alt = `Choice history for ${subjectId} on ${sessionDate}`;
  img.className = 'foraging-choice-history-img';
  img.loading = 'lazy';
  img.onerror = () => {
    imgWrapper.innerHTML = '<p class="detail-placeholder">Choice history plot not available for this session.</p>';
  };

  imgWrapper.appendChild(img);
  container.appendChild(imgWrapper);
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an acquisition event looks like a dynamic foraging session.
 *
 * Matches asset names like: behavior_844634_2026-05-22_125102
 */
export function isForagingAcquisition(event) {
  if (!event || event.type !== 'Acquisition') return false;
  const name = event.data?._assetName ?? event.event ?? '';
  return /^behavior_\d{6}_\d{4}-\d{2}-\d{2}/.test(name);
}

/**
 * Extract session identifiers from a foraging acquisition event.
 *
 * Asset names carry the session start time after the date, which may be
 * concatenated (`125102`) or hyphen/colon separated (`12-51-02`). The DF cache
 * stores `nwb_suffix` as the integer HHMMSS (leading zeros dropped), so we
 * strip separators and normalize through parseInt to match.
 *
 * @param {object} event - Timeline event
 * @returns {{ subject_id: string, session_date: string, nwb_suffix: string }|null}
 */
export function extractForagingSessionInfo(event) {
  const name = event.data?._assetName ?? event.event ?? '';
  const match = name.match(/^behavior_(\d{6})_(\d{4}-\d{2}-\d{2})_([\d:-]+)/);
  if (!match) return null;
  const timeDigits = match[3].replace(/\D/g, '');
  return {
    subject_id: match[1],
    session_date: match[2],
    nwb_suffix: timeDigits ? String(parseInt(timeDigits, 10)) : '',
  };
}
