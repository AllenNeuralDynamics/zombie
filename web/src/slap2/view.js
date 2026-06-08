/**
 * slap2/view.js — SLAP2 Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table) for all
 * assets with modality 'slap2'.
 */

import { createPlatformOverview } from '../lib/platform-overview.js';

export function createSlap2View(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view slap2-view';

  container.appendChild(
    createPlatformOverview(coord, {
      assetFilter: { type: 'modality', value: 'slap2' },
      platformKey: 'slap2',
    }),
  );

  return container;
}
