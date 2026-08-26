import { bootstrap } from '../lib/bootstrap.js';
import { createVerificationGraphView } from './verification-graph-view.js';

// The graph itself comes from the verification REST API, not DuckDB. bootstrap
// still runs so the page shell, theme and cache-version resolution match every
// other swdb page — and so the detail drawer can show the underlying cached
// data for a node's grounding without a second bring-up.
bootstrap((coord, metadata) => createVerificationGraphView(coord, metadata), { requiredTables: [] });
