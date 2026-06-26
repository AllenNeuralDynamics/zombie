import { bootstrap } from './lib/bootstrap.js';
import { createDynamicRoutingView } from './dynamic_routing/view.js';

bootstrap((coord) => createDynamicRoutingView(coord));
