/**
 * star/view.js — Cell Press "STAR Methods" viewer (/star?asset=…).
 *
 * Fetches a single DocDB record by name and renders a STAR-Methods section that
 * follows the official Cell Press structure: four numbered headings followed by
 * the Key Resources Table.  All data shaping lives in extract.js; this file is
 * DOM only.
 *
 * Exports:
 *   createStarView()  — DOM factory, returns HTMLElement.
 */

import { queryDocDb } from '../lib/docdb.js';
import { extractStarMethods } from './extract.js';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Anchor that opens in a new tab. */
function link(href, text) {
  const a = el('a', null, text ?? href);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * Render a KRT cell value. Per the STAR guide, an unavailable identifier must
 * read "N/A". value may be a string | {text, href} | null.
 */
function krtCell(value, className) {
  const td = el('td', className);
  if (value == null || value === '') {
    td.appendChild(el('span', 'star-na', 'N/A'));
    return td;
  }
  if (typeof value === 'object') {
    if (value.href) td.appendChild(link(value.href, value.text ?? value.href));
    else td.textContent = value.text ?? '';
    return td;
  }
  td.textContent = String(value);
  return td;
}

/** A numbered STAR section wrapper. */
function starSection(num, title) {
  const s = el('section', 'star-section');
  s.appendChild(el('h2', 'star-heading', `${num}. ${title}`));
  return s;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSummary(summary) {
  const box = el('section', 'star-summary');
  box.appendChild(el('h2', 'star-heading', 'Summary'));
  const dl = el('dl', 'star-dl');
  const add = (label, value) => {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return;
    dl.appendChild(el('dt', null, label));
    dl.appendChild(el('dd', null, Array.isArray(value) ? value.join(', ') : String(value)));
  };
  add('Subject', summary.subjectId);
  add('Project', summary.project);
  add('Institution', summary.institution);
  add('Modalities', summary.modalities);
  add('Acquisition type', summary.acquisitionType);
  add('Instrument', summary.instrument);
  add('Start', summary.start);
  add('End', summary.end);
  add('Experimenters', summary.experimenters);
  add('Investigators', summary.investigators);
  box.appendChild(dl);
  return box;
}

function renderFactList(facts) {
  const dl = el('dl', 'star-dl');
  for (const f of facts) {
    dl.appendChild(el('dt', null, f.label));
    dl.appendChild(el('dd', null, f.value));
  }
  return dl;
}

function renderModel(model) {
  const s = starSection(1, 'Experimental model and study participant details');
  if (!model.length) {
    s.appendChild(el('p', 'star-na', 'No experimental-model details reported.'));
  } else {
    s.appendChild(renderFactList(model));
  }
  return s;
}

function renderMethodDetails(md) {
  const s = starSection(2, 'Method details');

  // Acquisition overview.
  const overview = [];
  if (md.acquisitionType) overview.push(`Acquisition type: ${md.acquisitionType}`);
  if (md.instrument) overview.push(`instrument ${md.instrument}`);
  if (md.platform) overview.push(`mouse platform ${md.platform}`);
  if (overview.length) s.appendChild(el('p', null, overview.join(' · ')));

  // Procedures.
  if (md.procedures.length) {
    s.appendChild(el('h3', 'star-subheading', 'Procedures'));
    md.procedures.forEach((p) => {
      const para = el('p', 'star-proc');
      para.appendChild(el('strong', null, `${p.name}: `));
      para.appendChild(document.createTextNode(p.detail || '—'));
      s.appendChild(para);
    });
  }

  // Data acquisition streams.
  if (md.streams.length) {
    s.appendChild(el('h3', 'star-subheading', 'Data acquisition'));
    md.streams.forEach((st, i) => {
      const para = el('p', 'star-stream');
      para.appendChild(el('strong', null, `Stream ${i + 1}: `));
      const bits = [];
      if (st.modalities.length) bits.push(st.modalities.join(', '));
      if (st.start) bits.push(`${st.start} → ${st.end ?? '?'}`);
      if (st.configurations.length) bits.push(`configs: ${st.configurations.join('; ')}`);
      para.appendChild(document.createTextNode(bits.join(' · ')));
      if (st.notes) para.appendChild(el('span', 'star-note', ` — ${st.notes}`));
      s.appendChild(para);
    });
  }

  if (md.stimulusNames.length) {
    const para = el('p', null);
    para.appendChild(el('strong', null, 'Stimuli: '));
    para.appendChild(document.createTextNode(md.stimulusNames.join('; ')));
    s.appendChild(para);
  }

  if (md.notes) {
    const para = el('p', 'star-note', md.notes);
    s.appendChild(para);
  }
  return s;
}

function renderQuantification(q) {
  const s = starSection(3, 'Quantification and statistical analysis');
  if (!q.epochs.length && !q.subject.length) {
    s.appendChild(el('p', 'star-na', 'No quantification reported for this acquisition.'));
    return s;
  }
  q.epochs.forEach((e) => {
    s.appendChild(el('h3', 'star-subheading', e.name));
    s.appendChild(renderFactList(e.metrics.map((m) => ({ label: m.label, value: String(m.value) }))));
  });
  if (q.subject.length) {
    s.appendChild(el('h3', 'star-subheading', 'Subject measures'));
    s.appendChild(renderFactList(q.subject.map((m) => ({ label: m.label, value: String(m.value) }))));
  }
  return s;
}

function renderAdditionalResources(resources) {
  const s = starSection(4, 'Additional resources');
  if (!resources.length) {
    s.appendChild(el('p', 'star-na', 'No additional resources or protocols reported.'));
    return s;
  }
  const ul = el('ul', 'star-resources');
  for (const r of resources) {
    const li = el('li');
    li.appendChild(document.createTextNode(`${r.description}: `));
    if (r.href) li.appendChild(link(r.href, r.text));
    else li.appendChild(el('span', null, r.text));
    ul.appendChild(li);
  }
  s.appendChild(ul);
  return s;
}

function renderKrt(krt) {
  const s = starSection(5, 'Key resources table');

  const table = el('table', 'star-table');
  const thead = el('thead');
  const hr = el('tr');
  ['Reagent or Resource', 'Source', 'Identifier'].forEach((h) => hr.appendChild(el('th', null, h)));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  let any = false;
  for (const section of krt) {
    if (!section.rows || section.rows.length === 0) continue;
    any = true;
    const catRow = el('tr', 'star-category');
    const catCell = el('td', null, section.title);
    catCell.colSpan = 3;
    catRow.appendChild(catCell);
    tbody.appendChild(catRow);
    for (const r of section.rows) {
      const tr = el('tr');
      tr.appendChild(krtCell(r.resource, 'star-resource'));
      tr.appendChild(krtCell(r.source));
      tr.appendChild(krtCell(r.identifier, 'star-id'));
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  s.appendChild(table);
  if (!any) s.appendChild(el('p', 'star-na', 'No resources extracted from this record.'));
  return s;
}

// ---------------------------------------------------------------------------
// Page factory
// ---------------------------------------------------------------------------

export function createStarView() {
  const root = el('div', 'star-view');

  const params = new URLSearchParams(window.location.search);
  const asset = params.get('asset') ?? params.get('name') ?? '';

  if (!asset) {
    root.appendChild(el('p', 'record-error', 'No asset specified. Add ?asset=… to the URL.'));
    return root;
  }

  document.title = `${asset} — STAR Methods`;

  const headingRow = el('div', 'record-heading-row');
  headingRow.appendChild(el('h1', 'record-heading', asset));
  const recLink = el('a', 'star-record-link', 'View full metadata record →');
  recLink.href = `/record?name=${encodeURIComponent(asset)}`;
  headingRow.appendChild(recLink);
  root.appendChild(headingRow);

  root.appendChild(
    el(
      'p',
      'star-intro',
      'STAR Methods section auto-generated from the AIND metadata record, following the Cell Press STAR Methods structure (four headings plus a key resources table).',
    ),
  );

  const status = el('p', 'record-status', 'Loading…');
  root.appendChild(status);

  queryDocDb({ name: asset }, { limit: 1 })
    .then((results) => {
      if (!results || results.length === 0) {
        status.textContent = `No record found for "${asset}".`;
        return;
      }
      status.remove();
      const star = extractStarMethods(results[0]);
      root.appendChild(renderSummary(star.summary));
      root.appendChild(renderModel(star.model));
      root.appendChild(renderMethodDetails(star.methodDetails));
      root.appendChild(renderQuantification(star.quantification));
      root.appendChild(renderAdditionalResources(star.additionalResources));
      root.appendChild(renderKrt(star.krt));
    })
    .catch((err) => {
      status.className = 'record-error';
      status.textContent = `Failed to load record: ${err.message}`;
    });

  return root;
}
