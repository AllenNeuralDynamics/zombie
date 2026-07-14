import { bootstrap } from './lib/bootstrap.js';
import { createSizeView } from './size/view.js';

bootstrap((coord) => createSizeView(coord));
