/**
 * names-entry.js — Entry point for the hidden Name Normalization page (/names).
 *
 * Connects to DuckDB-WASM, loads asset_basics metadata, then renders
 * the experimenter name normalization graph.
 */

import { bootstrap } from './lib/bootstrap.js';
import { createNamesView } from './names/view.js';

bootstrap((coord) => createNamesView(coord));
