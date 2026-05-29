/**
 * dynamic_foraging/view.js — Dynamic Foraging Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table).
 */

import { createPlatformOverview } from '../lib/platform-overview.js';

export function createDynamicForagingView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view dynamic-foraging-view';

  container.appendChild(
    createPlatformOverview(coord, {
      platformKey: 'dynamic_foraging',
    }),
  );

  return container;
}
