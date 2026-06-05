import { bootstrap } from './lib/bootstrap.js';
import { createProjectView } from './project/view.js';

bootstrap((coord) => createProjectView({ coordinator: coord }), { graceful: true });
