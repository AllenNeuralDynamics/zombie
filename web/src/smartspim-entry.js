import { bootstrap } from './lib/bootstrap.js';
import { createSmartSpimView } from './smartspim/view.js';

bootstrap((coord) => createSmartSpimView(coord));
