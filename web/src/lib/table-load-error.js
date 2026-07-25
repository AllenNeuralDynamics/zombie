/**
 * lib/table-load-error.js — Shared, safe DOM renderers for table-load failures.
 *
 * Builds DOM nodes directly and assigns dynamic content via `textContent`
 * only — never via `innerHTML` — so a malformed table name or error message
 * can never be interpreted as markup.
 *
 * @module
 */

import { ISSUE_TRACKER_URL } from '../constants.js';
import { describeTableError, sanitizeErrorMessage, categorizeTableError } from './metadata.js';

function buildIssueLink() {
  const a = document.createElement('a');
  a.href = ISSUE_TRACKER_URL;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'Report this issue';
  return a;
}

function buildFailureList(failures) {
  const list = document.createElement('ul');
  list.className = 'table-load-error-list';
  for (const failure of failures) {
    const li = document.createElement('li');
    const strong = document.createElement('strong');
    strong.textContent = failure.table;
    li.appendChild(strong);
    li.appendChild(document.createTextNode(' — ' + describeTableError(failure.cause ?? failure.message)));
    list.appendChild(li);
  }
  return list;
}

function buildDiagnostics(failures, version) {
  const details = document.createElement('details');
  details.className = 'table-load-error-diagnostics';
  const summary = document.createElement('summary');
  summary.textContent = 'Diagnostics';
  details.appendChild(summary);

  const pre = document.createElement('pre');
  const lines = [
    `cache version: ${version ?? 'unknown'}`,
    `page: ${window.location.pathname}`,
    ...failures.map(
      (f) => `${f.table}: ${categorizeTableError(f.cause ?? f.message)} — ${sanitizeErrorMessage(f.message)}`,
    ),
  ];
  pre.textContent = lines.join('\n');
  details.appendChild(pre);
  return details;
}

/**
 * Build a blocking, full-page table-load error box for required-table
 * failures. Intended to replace the loading indicator / page content when a
 * required table (e.g. `asset_basics`) fails to register.
 *
 * @param {object} opts
 * @param {Array<{table: string, message: string, cause?: unknown}>} opts.failures
 *   Required-table failures.
 * @param {string|null} [opts.version] - Resolved cache-registry version, for diagnostics.
 * @param {string|null} [opts.context] - Optional page/feature name for the message.
 * @param {(() => void)|null} [opts.onRetry] - Called when "Try again" is clicked.
 * @returns {HTMLElement}
 */
export function buildTableLoadErrorBox({ failures = [], version = null, context = null, onRetry = null } = {}) {
  const box = document.createElement('div');
  box.className = 'card error table-load-error';
  box.setAttribute('role', 'alert');

  const heading = document.createElement('h2');
  heading.textContent = 'Data could not be loaded';
  box.appendChild(heading);

  const message = document.createElement('p');
  message.textContent = context
    ? `The ${context} page can't start because required data tables failed to load.`
    : "This page can't start because required data tables failed to load.";
  box.appendChild(message);

  box.appendChild(buildFailureList(failures));

  const actions = document.createElement('div');
  actions.className = 'table-load-error-actions';
  if (onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'table-load-error-retry';
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', () => onRetry());
    actions.appendChild(retryBtn);
  }
  actions.appendChild(buildIssueLink());
  box.appendChild(actions);

  box.appendChild(buildDiagnostics(failures, version));

  return box;
}

/**
 * Build a non-blocking warning box for optional-table failures. Intended to
 * be inserted near the top of an otherwise-usable page.
 *
 * @param {object} opts
 * @param {Array<{table: string, message: string, cause?: unknown}>} opts.failures
 *   Optional-table failures.
 * @param {string|null} [opts.version] - Resolved cache-registry version, for diagnostics.
 * @param {(() => void)|null} [opts.onDismiss] - Called after the box is dismissed.
 * @returns {HTMLElement}
 */
export function buildTableLoadWarningBox({ failures = [], version = null, onDismiss = null } = {}) {
  const box = document.createElement('div');
  box.className = 'warning-banner table-load-warning';
  box.setAttribute('role', 'status');

  const message = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = 'Some data could not be loaded: ';
  message.appendChild(strong);
  const names = failures.map((f) => f.table).join(', ');
  message.appendChild(document.createTextNode(`${names}. Related features may be unavailable.`));
  box.appendChild(message);

  box.appendChild(buildDiagnostics(failures, version));

  const actions = document.createElement('div');
  actions.className = 'table-load-warning-actions';
  actions.appendChild(buildIssueLink());

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'table-load-warning-dismiss';
  dismissBtn.setAttribute('aria-label', 'Dismiss warning');
  dismissBtn.textContent = '\u00d7';
  dismissBtn.addEventListener('click', () => {
    box.remove();
    onDismiss?.();
  });
  actions.appendChild(dismissBtn);
  box.appendChild(actions);

  return box;
}

/**
 * Build a small inline error note for a single feature-local (lazily loaded)
 * table failure. Intended to replace a panel's loading state without
 * blocking the rest of the page.
 *
 * @param {object} opts
 * @param {string} opts.table - The failed table name.
 * @param {unknown} [opts.cause] - The original error, used to categorize the message.
 * @param {(() => void)|null} [opts.onRetry] - Called when "Retry" is clicked.
 * @returns {HTMLElement}
 */
export function buildInlineTableError({ table, cause = null, onRetry = null } = {}) {
  const box = document.createElement('div');
  box.className = 'warning-banner table-load-warning table-load-inline-error';
  box.setAttribute('role', 'alert');

  const p = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = `${table}: `;
  p.appendChild(strong);
  p.appendChild(document.createTextNode(describeTableError(cause)));
  box.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'table-load-warning-actions';
  if (onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => onRetry());
    actions.appendChild(retryBtn);
  }
  actions.appendChild(buildIssueLink());
  box.appendChild(actions);

  return box;
}
