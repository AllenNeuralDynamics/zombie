/**
 * session-playback.js — Dispatcher that maps a subject-timeline acquisition
 * event to the matching platform's session-playback widget.
 *
 * Each platform page used to host its own "Session playback" section. Those
 * have been folded into the subject viewer's Event Details panel: when the
 * user selects an acquisition that qualifies for a platform's playback view,
 * the corresponding player is rendered inline below the overview card.
 *
 * Detection mirrors each platform page's own membership criteria:
 *   - Dynamic Foraging — asset name matches the foraging pattern
 *     (see isForagingAcquisition); platform filter: Coupled/Uncoupled Baiting.
 *   - Patch (VR) Foraging — acquisition_type === 'AindVrForaging'.
 *   - Dynamic Routing — project_name === 'Dynamic Routing'.
 *
 * The heavy player modules are imported on demand so the subject page's
 * initial bundle stays small (canvas animations + sprites are only pulled in
 * when a playable acquisition is actually opened).
 */

import {
  isForagingAcquisition,
  extractForagingSessionInfo,
} from './dynamic-foraging.js';

const DR_PROJECT_NAME = 'Dynamic Routing';
const VRF_ACQUISITION_TYPE = 'AindVrForaging';

/**
 * Determine which playback platform (if any) an acquisition event qualifies
 * for. Returns a platform key or null.
 *
 * @param {object} event - Subject timeline acquisition event.
 * @returns {'dynamic_foraging'|'vr_foraging'|'dynamic_routing'|null}
 */
export function detectPlaybackPlatform(event) {
  if (!event || event.type !== 'Acquisition') return null;
  const data = event.data ?? {};

  if (isForagingAcquisition(event)) return 'dynamic_foraging';
  if (data.acquisition_type === VRF_ACQUISITION_TYPE) return 'vr_foraging';
  if (data._project_name === DR_PROJECT_NAME) return 'dynamic_routing';

  return null;
}

/** Derive a Dynamic Routing session id ("<subject>_<YYYY-MM-DD>") from an event. */
function drSessionId(event, subjectId) {
  const sid = subjectId ?? event.data?.subject_id ?? null;
  const start = event.start instanceof Date ? event.start : null;
  const date = start ? start.toISOString().slice(0, 10) : null;
  if (!sid || !date) return null;
  return `${sid}_${date}`;
}

/**
 * Build a session-playback element for a qualifying acquisition event, or
 * null if the event does not qualify (or required context is missing).
 *
 * The returned element loads its data asynchronously and shows its own status
 * line, so callers can append it synchronously.
 *
 * @param {object} event - Subject timeline acquisition event.
 * @param {object} [context]
 * @param {object} [context.coordinator] - DuckDB coordinator.
 * @param {string} [context.subjectId]   - Subject ID (for DR session id).
 * @returns {HTMLElement|null}
 */
export function createSessionPlayback(event, context = {}) {
  const platform = detectPlaybackPlatform(event);
  if (!platform) return null;

  const coord = context.coordinator ?? null;
  if (!coord) return null;

  // Synchronous placeholder; the real widget replaces it after its lazy import.
  const mount = document.createElement('div');
  mount.className = 'session-playback-mount';
  const loading = document.createElement('p');
  loading.className = 'subject-loading';
  loading.textContent = 'Loading session playback…';
  mount.appendChild(loading);

  const swap = (el) => {
    if (el) loading.replaceWith(el);
    else loading.textContent = 'Session playback unavailable for this acquisition.';
  };

  if (platform === 'dynamic_foraging') {
    const session = extractForagingSessionInfo(event);
    if (!session) return null;
    import('../../dynamic_foraging/player.js')
      .then(({ createDfSessionPlayback }) => swap(createDfSessionPlayback(coord, session)))
      .catch((err) => { console.error('[playback] DF load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'vr_foraging') {
    const rawName = event.data?._assetName ?? null;
    if (!rawName) return null;
    import('../../vr_foraging/player.js')
      .then(({ createVrfSessionPlayback }) => swap(createVrfSessionPlayback(coord, rawName)))
      .catch((err) => { console.error('[playback] VRF load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'dynamic_routing') {
    const sessionId = drSessionId(event, context.subjectId);
    if (!sessionId) return null;
    import('../../dynamic_routing/player.js')
      .then(({ createDrSessionPlayback }) => swap(createDrSessionPlayback(coord, sessionId)))
      .catch((err) => { console.error('[playback] DR load failed', err); swap(null); });
    return mount;
  }

  return null;
}
