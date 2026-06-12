import { bootstrap } from './lib/bootstrap.js';
import { createExaSpimView } from './exaspim/view.js';

bootstrap((coord) => createExaSpimView(coord));
