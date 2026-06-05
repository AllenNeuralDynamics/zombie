import { bootstrap } from './lib/bootstrap.js';
import { createVrForagingView } from './vr_foraging/view.js';

bootstrap((coord) => createVrForagingView(coord));
