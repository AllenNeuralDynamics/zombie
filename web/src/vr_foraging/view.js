/**
 * vr_foraging/view.js — Patch Foraging Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table) for all
 * assets with acquisition_type = 'AindVrForaging'. Session playback now lives
 * in the subject viewer's Event Details panel (see
 * lib/behaviors/session-playback.js).
 */

import { createPlatformOverview } from '../lib/platform-overview.js';

export function createVrForagingView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view vr-foraging-view';

  container.appendChild(
    createPlatformOverview(coord, {
      assetFilter: { type: 'acquisition_type', value: 'AindVrForaging' },
      platformKey: 'vr',
    }),
  );

  return container;
}
