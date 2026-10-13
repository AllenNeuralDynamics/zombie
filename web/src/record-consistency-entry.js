import { bootstrap } from './lib/bootstrap.js';
import { createRecordConsistencyView } from './record_consistency/view.js';

bootstrap((coord) => createRecordConsistencyView(coord));
