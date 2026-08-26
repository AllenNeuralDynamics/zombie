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
import { createSonifierBridge } from './sonifier-bridge.js';

const DR_PROJECT_NAME = 'Dynamic Routing';
const VRF_ACQUISITION_TYPE = 'AindVrForaging';

/** Return true for the BCI project-name variants used in metadata records. */
export function isBciProject(projectName) {
  return /brain[\s-]*computer|(?:^|[\s_-])bci(?:$|[\s_-])/i.test(String(projectName ?? ''));
}

/** Return true for canonical Allen Brain Observatory Visual Coding Ophys assets. */
export function isVisualCodingOphysProject(projectName) {
  return /visual\s*coding\s*ophys/i.test(String(projectName ?? ''));
}

/**
 * Determine which playback platform (if any) an acquisition event qualifies
 * for. Returns a platform key or null.
 *
 * @param {object} event - Subject timeline acquisition event.
 * @returns {'dynamic_foraging'|'vr_foraging'|'dynamic_routing'|'mfish'|'bci'|'visual_coding_ophys'|null}
 */
export function detectPlaybackPlatform(event) {
  if (!event || event.type !== 'Acquisition') return null;
  const data = event.data ?? {};

  if (isForagingAcquisition(event)) return 'dynamic_foraging';
  if (data.acquisition_type === VRF_ACQUISITION_TYPE) return 'vr_foraging';
  if (isBciProject(data._project_name)) return 'bci';
  if (isVisualCodingOphysProject(data._project_name)
      && (event.modalities ?? []).some((modality) => /pophys|ophys/i.test(String(modality)))) {
    return 'visual_coding_ophys';
  }
  if (/mfish/i.test(data._project_name ?? '') && (event.modalities ?? []).includes('behavior')) return 'mfish';
  if (data._project_name === DR_PROJECT_NAME && (event.modalities ?? []).includes('behavior')) return 'dynamic_routing';

  return null;
}

/** True only for Dynamic Routing acquisitions that include ecephys data. */
export function isDynamicRoutingEcephys(event) {
  return detectPlaybackPlatform(event) === 'dynamic_routing'
    && (event?.modalities ?? []).some((modality) => /ecephys/i.test(String(modality)));
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
 * Build the platform-specific player mount for a qualifying acquisition, or
 * null if the event does not qualify (or required context is missing).
 *
 * @param {'dynamic_foraging'|'vr_foraging'|'dynamic_routing'|'mfish'|'bci'|'visual_coding_ophys'} platform
 * @param {object} event   - Subject timeline acquisition event.
 * @param {object} context - { coordinator, subjectId }.
 * @param {object} coord   - DuckDB coordinator.
 * @returns {HTMLElement|null}
 */
function buildPlatformPlayer(platform, event, context, coord, extraOpts = {}) {
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

  // Shared options: header metadata + raw asset location (for behavior videos).
  const playerOpts = {
    acquisitionType: event.data?.acquisition_type ?? '',
    projectName: event.data?._project_name ?? '',
    location: event.data?._location ?? null,
    ...extraOpts,
  };

  if (platform === 'dynamic_foraging') {
    const session = extractForagingSessionInfo(event);
    if (!session) return null;
    import('../../dynamic_foraging/player.js')
      .then(({ createDfSessionPlayback }) => swap(createDfSessionPlayback(coord, session, playerOpts)))
      .catch((err) => { console.error('[playback] DF load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'vr_foraging') {
    const rawName = event.data?._assetName ?? null;
    if (!rawName) return null;
    import('../../vr_foraging/player.js')
      .then(({ createVrfSessionPlayback }) => swap(createVrfSessionPlayback(coord, rawName, playerOpts)))
      .catch((err) => { console.error('[playback] VRF load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'dynamic_routing') {
    const sessionId = drSessionId(event, context.subjectId);
    if (!sessionId) return null;
    import('../../dynamic_routing/player.js')
      .then(({ createDrSessionPlayback }) => swap(createDrSessionPlayback(coord, sessionId, playerOpts)))
      .catch((err) => { console.error('[playback] DR load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'mfish') {
    const rawName = event.data?._assetName ?? null;
    if (!rawName) return null;
    import('../../mfish/player.js')
      .then(({ createMfishSessionPlayback }) => swap(createMfishSessionPlayback(coord, rawName, playerOpts)))
      .catch((err) => { console.error('[playback] mFISH load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'bci') {
    const rawName = event.data?._assetName ?? null;
    if (!rawName) return null;
    import('../../bci/player.js')
      .then(({ createBciSessionPlayback }) => swap(createBciSessionPlayback(coord, rawName, playerOpts)))
      .catch((err) => { console.error('[playback] BCI load failed', err); swap(null); });
    return mount;
  }

  if (platform === 'visual_coding_ophys') {
    import('../../visual_coding_ophys/view.js')
      .then(({ createVisualCodingOphysViewer }) => swap(createVisualCodingOphysViewer(coord, event)))
      .catch((err) => { console.error('[playback] Visual Coding Ophys load failed', err); swap(null); });
    return mount;
  }

  return null;
}

/**
 * Build a session-playback element for an acquisition event, or null if the
 * event qualifies for neither a platform player nor a fiber-photometry panel
 * (or required context is missing).
 *
 * When the acquisition has corresponding fiber-photometry traces, a fiber
 * panel is appended below the platform player. The panel loads its own data
 * asynchronously and removes itself if no fiber data exists for the asset.
 *
 * The returned element loads its data asynchronously and shows its own status
 * line, so callers can append it synchronously.
 *
 * @param {object} event - Subject timeline acquisition event.
 * @param {object} [context]
 * @param {object} [context.coordinator] - DuckDB coordinator.
 * @param {string} [context.subjectId]   - Subject ID (for DR session id / fiber).
 * @returns {HTMLElement|null}
 */
export function createSessionPlayback(event, context = {}) {
  if (!event || event.type !== 'Acquisition') return null;

  const coord = context.coordinator ?? null;
  if (!coord) return null;

  const platform = detectPlaybackPlatform(event);
  const subjectId = context.subjectId ?? event.data?.subject_id ?? null;
  const rawAssetName = event.data?._assetName ?? null;
  // Only offer the fiber panel when the acquisition actually has a fiber
  // photometry modality. Otherwise the fiber panel silently removes itself
  // (no data) and leaves an empty "Data" tab.
  const modalities = event.modalities ?? [];
  const hasFiberModality = modalities.some((m) => /^fib/i.test(String(m)));
  const canFiber = !!(subjectId && rawAssetName && hasFiberModality);
  const hasEcephysModality = modalities.some((m) => /ecephys/i.test(String(m)));
  const canEcephys = !!(subjectId && rawAssetName && hasEcephysModality);
  const canDynamicRoutingRaster = isDynamicRoutingEcephys(event) && canEcephys;
  const hasPophysModality = modalities.some((m) => /pophys/i.test(String(m)));
  // BCI has a separate behavior-NWB-backed player. Do not append the legacy
  // pophys panel as well; its NWB-Zarr assumptions do not match these assets.
  const canPophys = platform !== 'bci' && platform !== 'visual_coding_ophys'
    && !!(rawAssetName && hasPophysModality);

  if (!platform && !canFiber && !canEcephys && !canPophys) return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'session-playback-wrapper';

  // Additional-modality panels (fiber / ecephys) are siblings of the platform
  // player. The VR-foraging player's non-Playback tabs (patch ethogram /
  // aligned) hide them via this callback so only the selected figure shows.
  const modalityMounts = [];
  const setModalitiesVisible = (visible) => {
    for (const m of modalityMounts) m.hidden = !visible;
  };

  // Bridge between the ecephys panel's Spike-Jukebox button and the corridor
  // player's transport/DOM. Only the VRF corridor player registers itself, so
  // the button only surfaces when a corridor is present.
  const sonifierBridge = createSonifierBridge();

  let hasPlayer = false;
  if (platform) {
    const playerEl = buildPlatformPlayer(platform, event, context, coord, {
      onModalitiesVisible: setModalitiesVisible,
      sonifierBridge,
    });
    if (playerEl) { wrapper.appendChild(playerEl); hasPlayer = true; }
  }

  if (canEcephys) {
    const ephysMount = document.createElement('div');
    ephysMount.className = 'session-playback-modality';
    wrapper.appendChild(ephysMount);
    modalityMounts.push(ephysMount);
    import('../../ecephys/ecephys-playback.js')
      .then(({ createEcephysPlayback }) => {
        const ephysEl = createEcephysPlayback(
          coord,
          String(subjectId),
          rawAssetName,
          sonifierBridge,
          platform,
        );
        if (hasPlayer) {
          const hr = document.createElement('hr');
          hr.className = 'session-playback-sep';
          ephysMount.appendChild(hr);
        }
        ephysMount.appendChild(ephysEl);
      })
      .catch((err) => { console.error('[playback] ecephys load failed', err); });
  }

  if (canDynamicRoutingRaster) {
    const rasterMount = document.createElement('div');
    rasterMount.className = 'session-playback-modality';
    wrapper.appendChild(rasterMount);
    modalityMounts.push(rasterMount);
    import('../../dynamic_routing_raster/view.js')
      .then(({ createDynamicRoutingRasterSection }) => {
        const hr = document.createElement('hr');
        hr.className = 'session-playback-sep';
        rasterMount.appendChild(hr);
        rasterMount.appendChild(createDynamicRoutingRasterSection(coord, rawAssetName));
      })
      .catch((err) => { console.error('[playback] dynamic routing raster load failed', err); });
  }

  if (canFiber) {
    const fiberMount = document.createElement('div');
    fiberMount.className = 'session-playback-modality';
    wrapper.appendChild(fiberMount);
    modalityMounts.push(fiberMount);
    import('../../fiber_photometry/fib-playback.js')
      .then(({ createFibPlayback }) => {
        const fiberEl = createFibPlayback(coord, String(subjectId), rawAssetName, {
          behaviorPlatform: platform,
        });
        // Separate additional modalities (fiber, …) from the behavior player
        // above with a horizontal rule.
        if (hasPlayer || canEcephys) {
          const hr = document.createElement('hr');
          hr.className = 'session-playback-sep';
          fiberMount.appendChild(hr);
        }
        fiberMount.appendChild(fiberEl);
      })
      .catch((err) => { console.error('[playback] fiber load failed', err); });
  }

  if (canPophys) {
    const pophysMount = document.createElement('div');
    pophysMount.className = 'session-playback-modality';
    wrapper.appendChild(pophysMount);
    modalityMounts.push(pophysMount);
    import('../../pophys/view.js')
      .then(({ createPophysViewer }) => {
        const pophysEl = createPophysViewer(coord, event);
        if (hasPlayer || canEcephys || canFiber) {
          const hr = document.createElement('hr');
          hr.className = 'session-playback-sep';
          pophysMount.appendChild(hr);
        }
        pophysMount.appendChild(pophysEl);
      })
      .catch((err) => { console.error('[playback] pophys load failed', err); });
  }

  return wrapper;
}
