import { bootstrap } from './lib/bootstrap.js';
import { createUpgradeView } from './upgrade/view.js';

bootstrap((coord) => createUpgradeView({ coordinator: coord }));
