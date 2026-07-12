/**
 * star-entry.js — Entry point for the hidden STAR Methods viewer (/star).
 *
 * No DuckDB needed — the page fetches directly from the DocDB REST API.
 */

import { createStarView } from './star/view.js';

const app = document.getElementById('app');
app.innerHTML = '';
app.appendChild(createStarView());
