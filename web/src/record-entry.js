/**
 * record-entry.js — Entry point for the hidden Metadata Record viewer (/record).
 *
 * No DuckDB needed — the page fetches directly from the DocDB REST API.
 */

import { createRecordView } from './record/view.js';

const app = document.getElementById('app');
app.innerHTML = '';
app.appendChild(createRecordView());
