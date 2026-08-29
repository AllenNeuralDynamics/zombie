/**
 * Task playback for the Visual Learning SWDB dataset.
 *
 * The player is the same mFISH task player used by the individual session
 * view. This wrapper only resolves the raw acquisition behind a processed
 * Visual Learning asset, exposes a dataset-level session picker, and forwards
 * the task event plot's time window to the cell-activity view.
 *
 * The per-cell-subclass activity row shown below Running inside the event
 * plot is driven from outside: the ROI dF/F reads already happen in
 * visual-learning-activity.js (it needs them for the cell-type heatmap), so
 * this module just forwards whatever series it's handed to the player via
 * `setSubclassActivity` rather than re-reading NWB traces itself. That call
 * commonly arrives before the player has finished loading behavior data, so
 * it's buffered here and re-applied once a player exists.
 */

import { resolveVisualLearningPlaybackSource, loadVisualLearningProgression } from './data.js';
import { createMfishSessionPlayback } from '../mfish/player.js';

function sourceNamesForAsset(asset, sourceMap) {
  return sourceMap?.[asset.asset_name]
    ?? sourceMap?.[asset.name]
    ?? [];
}

/** Build the Visual Learning task playback panel. */
export function createVisualLearningTaskPlayback(
  coord,
  { onSelect = null, onTimeDomainChange = null, onTimeChange = null } = {},
) {
  const section = document.createElement('section');
  section.className = 'swdb-visual-learning-playback';

  const heading = document.createElement('div');
  heading.className = 'swdb-visual-learning-playback-heading';
  const title = document.createElement('h2');
  title.textContent = 'Task playback';
  heading.appendChild(title);

  const selection = document.createElement('label');
  selection.className = 'swdb-visual-learning-playback-selection';
  selection.textContent = 'Session';
  const sessionSelect = document.createElement('select');
  selection.appendChild(sessionSelect);
  heading.appendChild(selection);
  section.appendChild(heading);

  const mount = document.createElement('div');
  mount.className = 'swdb-visual-learning-playback-mount';
  const initialStatus = document.createElement('div');
  initialStatus.className = 'swdb-panel-status';
  initialStatus.textContent = 'Select a session to load task playback.';
  mount.appendChild(initialStatus);
  section.appendChild(mount);

  let assetsByName = new Map();
  let sourceMap = {};
  let controller = null;
  let currentPlayer = null;
  let pendingSubclassActivity = null;

  function disposePlayer() {
    currentPlayer?._dispose?.();
    currentPlayer = null;
  }

  async function select(sessionOrName, { notify = true } = {}) {
    const session = typeof sessionOrName === 'string'
      ? assetsByName.get(sessionOrName)
      : sessionOrName;
    if (!session?.asset_name) return;

    sessionSelect.value = session.asset_name;
    if (notify) onSelect?.(session);
    controller?.abort();
    controller = new AbortController();
    disposePlayer();
    pendingSubclassActivity = null;
    mount.replaceChildren();
    const status = document.createElement('div');
    status.className = 'swdb-panel-status';
    status.textContent = 'Resolving task data…';
    mount.appendChild(status);

    try {
      const source = await resolveVisualLearningPlaybackSource(
        coord,
        sourceNamesForAsset(session, sourceMap),
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!source) {
        status.textContent = 'No raw task acquisition is linked to this session.';
        return;
      }

      const player = createMfishSessionPlayback(coord, source.name, {
        acquisitionType: session.session_type ?? '',
        location: source.location ?? null,
        onTimeDomainChange: (domain) => onTimeDomainChange?.(domain, session),
        onTimeChange: (time) => onTimeChange?.(time, session),
      });
      currentPlayer = player;
      mount.replaceChildren(player);
      if (pendingSubclassActivity) player.setSubclassActivity(pendingSubclassActivity);
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent = 'Could not load task playback: ' + error.message;
      console.error('[SWDB] Visual Learning task playback load failed', error);
    }
  }

  sessionSelect.addEventListener('change', () => select(sessionSelect.value));

  return {
    element: section,
    load(assets, nextSourceMap = {}) {
      sourceMap = nextSourceMap;
      const sessions = loadVisualLearningProgression(assets)
        .filter((session) => session.asset_name)
        .sort((a, b) => String(a.session_date ?? '').localeCompare(String(b.session_date ?? '')));
      assetsByName = new Map(sessions.map((session) => [session.asset_name, session]));
      sessionSelect.replaceChildren(...sessions.map((session) => {
        const option = document.createElement('option');
        option.value = session.asset_name;
        option.textContent = String(session.subject_id ?? 'unknown') + ' · '
          + String(session.session_date ?? 'undated').slice(0, 10) + ' · '
          + String(session.session_type ?? 'session');
        return option;
      }));
      sessionSelect.disabled = sessions.length === 0;
      if (!sessions.length) {
        mount.replaceChildren();
        const status = document.createElement('div');
        status.className = 'swdb-panel-status';
        status.textContent = 'No Visual Learning sessions are available.';
        mount.appendChild(status);
      }
    },
    select,
    /** Forward the per-subclass activity series to the event plot's extra row. */
    setSubclassActivity(series) {
      pendingSubclassActivity = series;
      currentPlayer?.setSubclassActivity(series);
    },
    dispose() {
      controller?.abort();
      disposePlayer();
    },
  };
}
