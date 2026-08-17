import { bootstrap } from './lib/bootstrap.js';
import { createTimelineView } from './timeline/view.js';

bootstrap((coord) => createTimelineView(coord));
