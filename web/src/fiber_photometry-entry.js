import { bootstrap } from './lib/bootstrap.js';
import { createFiberPhotometryView } from './fiber_photometry/view.js';

bootstrap((coord) => createFiberPhotometryView(coord));
