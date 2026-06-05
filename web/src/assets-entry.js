import { bootstrap } from './lib/bootstrap.js';
import { createAssetsView } from './assets/view.js';

bootstrap((coord) => createAssetsView(coord));
