import { bootstrap } from './lib/bootstrap.js';
import { createSessionsView } from './sessions/view.js';

bootstrap((coord) => createSessionsView(coord));
