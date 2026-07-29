import { bootstrap } from './lib/bootstrap.js';
import { createSwdbIndexView } from './swdb/index-view.js';

// The SWDB pages read only their own `platform_swdb_*` cache tables via explicit
// parquet URLs, so no eager tables are registered — bootstrap is used purely to
// bring up DuckDB-WASM and resolve the cache version.
bootstrap((coord) => createSwdbIndexView(coord), { requiredTables: [] });
