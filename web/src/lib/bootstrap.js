/**
 * lib/bootstrap.js — Shared entry-point bootstrap for DuckDB-backed pages.
 *
 * Eliminates the ~30 lines of identical boilerplate in every *-entry.js file.
 *
 * Usage:
 *   import { bootstrap } from './lib/bootstrap.js';
 *   bootstrap((coord, metadata) => createMyView(coord));
 *
 * @module
 */

import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './metadata.js';
import { setMetadata } from './registry.js';
import { VERSIONS_URL } from '../constants.js';

/**
 * Connect DuckDB, fetch metadata, register tables, then call the view factory.
 *
 * @param {(coord: object, metadata: object) => HTMLElement | Promise<HTMLElement>} createView
 *   Factory function that receives the coordinator and metadata and returns
 *   the root DOM element to mount into `#app`.
 * @param {object} [opts]
 * @param {boolean} [opts.graceful=false] - If true, still mount the view even
 *   if DuckDB/metadata fails (coordinator passed as null). Used by pages like
 *   subject/project that can partially work without DuckDB.
 */
export async function bootstrap(createView, { graceful = false } = {}) {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  // The loading element already renders a spinning circle via CSS (::before).
  // We only update its text label as tables come online — never replace the
  // whole content with a progress bar.
  function setLabel(text) {
    if (loadingEl) loadingEl.textContent = text;
  }

  function onProgress({ phase, total, name }) {
    // Skip the fast preliminary phases (versions/registry) — they finish in
    // well under a second and the flicker is more distracting than useful.
    if (phase !== 'table') return;
    // When many tables are being loaded, don't enumerate each one — just a
    // single label until they're all ready.
    if (total > 3) {
      setLabel('Loading from cache…');
    } else {
      setLabel(`Loading ${name}…`);
    }
  }

  let coord = null;
  let metadata = null;

  try {
    coordinator().databaseConnector(wasmConnector());
    metadata = await fetchAndRegisterMetadata(coordinator(), VERSIONS_URL, { onProgress });
    setMetadata(metadata);
    coord = coordinator();
    if (loadingEl) loadingEl.remove();
  } catch (err) {
    if (graceful) {
      console.warn('[bootstrap] DuckDB unavailable, continuing in graceful mode:', err?.message);
      if (loadingEl) loadingEl.remove();
    } else {
      console.error('[bootstrap] Initialisation failed:', err);
      if (loadingEl) {
        loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
        loadingEl.className = 'loading-message error';
      }
      return;
    }
  }

  try {
    const el = await createView(coord, metadata);
    if (el) app.appendChild(el);
  } catch (err) {
    console.error('[bootstrap] View creation failed:', err);
    if (loadingEl && loadingEl.parentNode) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    } else {
      app.innerHTML = `<p class="loading-message error">Failed to load: ${err?.message ?? err}</p>`;
    }
  }
}
