import { bootstrap } from './lib/bootstrap.js';
import { createCombinedView } from './combined/view.js';

bootstrap((coord) => createCombinedView({ coordinator: coord }), { graceful: true });
