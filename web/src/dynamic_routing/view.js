/**
 * dynamic_routing/view.js — Dynamic Routing Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table) for all
 * assets with project_name = 'Dynamic Routing'. Session playback now lives in
 * the subject viewer's Event Details panel (see lib/behaviors/session-playback.js).
 */

import { createPlatformOverview } from '../lib/platform-overview.js';

export function createDynamicRoutingView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view dynamic-routing-view';

  container.appendChild(
    createPlatformOverview(coord, {
      assetFilter: { type: 'project_name', value: 'Dynamic Routing' },
      platformKey: 'dynamic_routing',
    }),
  );

  return container;
}
