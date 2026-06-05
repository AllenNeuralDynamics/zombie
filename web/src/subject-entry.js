import { bootstrap } from './lib/bootstrap.js';
import { createSubjectView } from './subject/view.js';

bootstrap((coord) => createSubjectView({ coordinator: coord }), { graceful: true });
