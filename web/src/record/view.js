/**
 * record/view.js — Metadata record JSON viewer.
 *
 * Fetches a single record from DocDB by name and renders it as a
 * fully-expanded, interactive JSON tree.  Wherever a `subject_id` string
 * value appears in the record it is rendered as a link to the subject page;
 * likewise `project_name` values link to the project page.
 *
 * Exports:
 *   createRecordView()  — DOM factory, returns HTMLElement.
 *   renderJsonValue()   — Pure helper, exported for unit tests.
 */

import { escHtml, normalizeProtocolId } from '../lib/utils.js';
import { queryDocDb } from '../lib/docdb.js';
import { buildCoLink } from '../assets/links.js';

// ---------------------------------------------------------------------------
// Protocol title fetcher
// ---------------------------------------------------------------------------

async function fetchProtocolTitle(canonicalUrl) {
  try {
    const doi = canonicalUrl.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
    const res = await fetch(`https://api.crossref.org/works/${doi}`);
    if (!res.ok) return null;
    const data = await res.json();
    const titles = data?.message?.title;
    return Array.isArray(titles) && titles.length > 0 ? titles[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// JSON tree renderer
// ---------------------------------------------------------------------------

/**
 * Build a link element.
 * @param {string} href
 * @param {string} text
 * @returns {HTMLAnchorElement}
 */
function makeLink(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
}

/**
 * Render a single JSON value (any type) as a DOM node.
 *
 * Special cases:
 *   - Objects and Arrays → <details open> tree
 *   - subject_id string values → linked to /view?subject_id=…
 *   - project_name string values → linked to /view?project=…
 *
 * @param {unknown} value - The JSON value to render.
 * @param {string|null} [parentKey=null] - The key under which this value lives
 *   (used to decide whether to linkify strings).
 * @returns {Node}
 */
export function renderJsonValue(value, parentKey = null) {
  if (value === null) {
    const span = document.createElement('span');
    span.className = 'json-null';
    span.textContent = 'null';
    return span;
  }

  if (typeof value === 'boolean') {
    const span = document.createElement('span');
    span.className = 'json-bool';
    span.textContent = String(value);
    return span;
  }

  if (typeof value === 'number') {
    const span = document.createElement('span');
    span.className = 'json-number';
    span.textContent = String(value);
    return span;
  }

  if (typeof value === 'string') {
    if (parentKey === 'subject_id' && value) {
      return makeLink(`/view?subject_id=${encodeURIComponent(value)}`, value);
    }
    if (parentKey === 'project_name' && value) {
      return makeLink(`/view?project=${encodeURIComponent(value)}`, value);
    }
    if (parentKey === 'Code Ocean' && value) {
      const href = buildCoLink(value);
      if (href) return makeLink(href, value);
    }
    if (parentKey === 'protocol_id' && value) {
      const url = normalizeProtocolId(value);
      if (url) {
        const a = makeLink(url, value);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        fetchProtocolTitle(url).then((title) => {
          if (title) a.textContent = title;
        });
        return a;
      }
    }
    const span = document.createElement('span');
    span.className = 'json-string';
    span.textContent = `"${value}"`;
    return span;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      const span = document.createElement('span');
      span.className = 'json-empty';
      span.textContent = '[]';
      return span;
    }

    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'json-bracket';
    summary.textContent = `[ ${value.length} item${value.length !== 1 ? 's' : ''} ]`;
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'json-array';
    value.forEach((item, i) => {
      const li = document.createElement('li');
      const indexSpan = document.createElement('span');
      indexSpan.className = 'json-index';
      indexSpan.textContent = `${i}: `;
      li.appendChild(indexSpan);
      // Pass parentKey down so subject_id / project_name inside arrays are also linked
      li.appendChild(renderJsonValue(item, parentKey));
      ul.appendChild(li);
    });
    details.appendChild(ul);
    return details;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      const span = document.createElement('span');
      span.className = 'json-empty';
      span.textContent = '{}';
      return span;
    }

    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.className = 'json-bracket';
    summary.textContent = `{ ${keys.length} key${keys.length !== 1 ? 's' : ''} }`;
    details.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'json-object';
    keys.forEach((k) => {
      const li = document.createElement('li');
      const keySpan = document.createElement('span');
      keySpan.className = 'json-key';
      keySpan.textContent = `"${k}": `;
      li.appendChild(keySpan);
      li.appendChild(renderJsonValue(value[k], k));
      ul.appendChild(li);
    });
    details.appendChild(ul);
    return details;
  }

  // Fallback for unexpected types
  const span = document.createElement('span');
  span.textContent = escHtml(String(value));
  return span;
}

// ---------------------------------------------------------------------------
// Page view
// ---------------------------------------------------------------------------

/**
 * Create and return the record viewer DOM element.
 *
 * Reads `?name=` from the current URL, fetches the matching DocDB record, and
 * renders the JSON tree into the returned root element.
 *
 * @returns {HTMLElement}
 */
export function createRecordView() {
  const root = document.createElement('div');
  root.className = 'record-view';

  const params = new URLSearchParams(window.location.search);
  const name = params.get('name') ?? '';
  const initialView = params.get('view') === 'interactive' ? 'interactive' : 'json';

  if (!name) {
    const msg = document.createElement('p');
    msg.className = 'record-error';
    msg.textContent = 'No asset name specified. Add ?name=… to the URL.';
    root.appendChild(msg);
    return root;
  }

  // Update the page title to reflect the asset name
  document.title = `${name} — Metadata`;

  const headingRow = document.createElement('div');
  headingRow.className = 'record-heading-row';

  const heading = document.createElement('h1');
  heading.className = 'record-heading';
  heading.textContent = name;
  headingRow.appendChild(heading);

  // View toggle: JSON (default) ↔ Interactive record diagram.
  const toggle = document.createElement('div');
  toggle.className = 'record-view-toggle';
  const jsonTabBtn = document.createElement('button');
  jsonTabBtn.className = 'record-tab is-active';
  jsonTabBtn.textContent = 'JSON';
  const interactiveTabBtn = document.createElement('button');
  interactiveTabBtn.className = 'record-tab';
  interactiveTabBtn.textContent = 'Interactive';
  interactiveTabBtn.disabled = true;
  toggle.appendChild(jsonTabBtn);
  toggle.appendChild(interactiveTabBtn);
  headingRow.appendChild(toggle);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'record-copy-btn';
  copyBtn.textContent = 'Copy JSON';
  copyBtn.disabled = true;
  headingRow.appendChild(copyBtn);

  root.appendChild(headingRow);

  const status = document.createElement('p');
  status.className = 'record-status';
  status.textContent = 'Loading…';
  root.appendChild(status);

  const tree = document.createElement('div');
  tree.className = 'record-tree';
  root.appendChild(tree);

  // Mount point for the React interactive diagram — populated lazily on first
  // switch so React + React Flow never load for the default JSON view.
  const interactive = document.createElement('div');
  interactive.className = 'record-interactive';
  interactive.hidden = true;
  root.appendChild(interactive);

  queryDocDb({ name }, { limit: 1 })
    .then((results) => {
      if (!results || results.length === 0) {
        status.textContent = `No record found for "${name}".`;
        return;
      }
      status.remove();
      const record = results[0];
      const rawJson = JSON.stringify(record, null, 2);
      copyBtn.disabled = false;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(rawJson).then(() => {
          const prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = prev; }, 1500);
        });
      });
      tree.appendChild(renderJsonValue(record));

      let mounted = false;
      const setViewParam = (mode) => {
        const url = new URL(window.location.href);
        if (mode === 'interactive') url.searchParams.set('view', 'interactive');
        else url.searchParams.delete('view');
        history.replaceState({}, '', url);
      };
      const showJson = () => {
        tree.hidden = false;
        interactive.hidden = true;
        jsonTabBtn.classList.add('is-active');
        interactiveTabBtn.classList.remove('is-active');
        setViewParam('json');
      };
      const showInteractive = () => {
        tree.hidden = true;
        interactive.hidden = false;
        interactiveTabBtn.classList.add('is-active');
        jsonTabBtn.classList.remove('is-active');
        setViewParam('interactive');
        if (!mounted) {
          mounted = true;
          interactive.textContent = 'Loading interactive view…';
          import('./interactive/mount.js')
            .then(({ mountRecordDiagram }) => {
              interactive.textContent = '';
              mountRecordDiagram(interactive, record);
            })
            .catch((err) => {
              mounted = false;
              interactive.textContent = `Failed to load interactive view: ${err.message}`;
            });
        }
      };
      jsonTabBtn.addEventListener('click', showJson);
      interactiveTabBtn.addEventListener('click', showInteractive);
      interactiveTabBtn.disabled = false;
      if (initialView === 'interactive') showInteractive();
    })
    .catch((err) => {
      status.className = 'record-error';
      status.textContent = `Failed to load record: ${err.message}`;
    });

  return root;
}
