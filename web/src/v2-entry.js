import { bootstrap } from './lib/bootstrap.js';
import { createV2View } from './v2/view.js';

bootstrap((coord) => createV2View({ coordinator: coord }));
