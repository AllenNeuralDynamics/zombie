import { bootstrap } from './lib/bootstrap.js';
import { createSlap2View } from './slap2/view.js';

bootstrap((coord) => createSlap2View(coord));
