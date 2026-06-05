import { bootstrap } from './lib/bootstrap.js';
import { createDynamicForagingView } from './dynamic_foraging/view.js';

bootstrap((coord) => createDynamicForagingView(coord));
