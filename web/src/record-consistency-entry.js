import { bootstrap } from './lib/bootstrap.js';
import { createRecordConsistencyView } from './record-consistency/view.js';

// The page reads only its own lazy-loaded flags table; asset_basics is not
// needed at startup and should not block the findings view.
bootstrap((coord) => createRecordConsistencyView(coord), { requiredTables: [] });
