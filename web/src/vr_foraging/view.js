/**
 * vr_foraging/view.js — VR Foraging Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table) for all
 * assets with acquisition_type = 'AindVrForaging'.
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
