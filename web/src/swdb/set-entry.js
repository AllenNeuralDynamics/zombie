import { bootstrap } from '../lib/bootstrap.js';
import { createSwdbSetView } from './set-view.js';

// See swdb-entry.js: no eager tables, DuckDB + cache-version resolution only.
bootstrap((coord, metadata) => createSwdbSetView(coord, metadata), { requiredTables: [] });
