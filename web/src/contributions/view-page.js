/**
 * view-page.js — Read-only contributions view with version dropdown.
 *
 * Loads the contribution data for a DOI/project and renders the preview widget
 * with a version selector in the top-right corner.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { createPreview } from './preview.js';
import { fromEndpointPayload, rowsToWidgetAuthors, CREDIT_ROLE_ENUM } from './view.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractViewMeta(data) {
  const sections = [];
  for (const raw of (Array.isArray(data.sections) ? data.sections : [])) {
    const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
    if (title) sections.push({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title });
  }

  const affiliations = new Map();
  const authorOrcids = {};
  const authorAffIds = {};
  const creditLinkedSections = {};

  for (const contributor of data.contributors || []) {
    const name = contributor.author?.name;
    if (!name) continue;
    const orcid = contributor.author?.registry_identifier;
    if (orcid) authorOrcids[name] = orcid;
    const affRaw = contributor.author?.affiliation;
    const affArr = Array.isArray(affRaw) ? affRaw : (typeof affRaw === 'string' && affRaw ? [affRaw] : []);
    for (const affStr of affArr) {
      if (!affiliations.has(affStr)) {
        affiliations.set(affStr, affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      }
    }
    if (affArr.length) authorAffIds[name] = affArr.map((s) => affiliations.get(s));
    for (const cl of contributor.credit_levels || []) {
      if (cl.linked_sections?.length) {
        const secByTitle = new Map(sections.map((s) => [s.title, s.id]));
        const sectionIds = cl.linked_sections
          .map((s) => secByTitle.get(typeof s === 'string' ? s : (s.section || s.title || '')))
          .filter(Boolean);
        if (sectionIds.length) {
          if (!creditLinkedSections[name]) creditLinkedSections[name] = {};
          creditLinkedSections[name][cl.role] = sectionIds;
        }
      }
    }
  }

  return {
    authorOrcids,
    authorAffIds,
    affiliations: [...affiliations.entries()].map(([name, id]) => ({ id, name })),
    sections,
    creditLinkedSections,
  };
}

function buildPreviewAuthors(rows, meta) {
  const { authorOrcids, authorAffIds, affiliations, sections, creditLinkedSections } = meta;
  return rowsToWidgetAuthors(rows).map((a) => {
    const affIds = authorAffIds[a.name] || [];
    const affNames = affIds.map((id) => affiliations.find((af) => af.id === id)?.name).filter(Boolean);
    const allSecIds = new Set();
    for (const roleEnum of Object.values(CREDIT_ROLE_ENUM))
      for (const id of (creditLinkedSections[a.name]?.[roleEnum] || [])) allSecIds.add(id);
    const sectionContribs = [...allSecIds]
      .map((id) => sections.find((s) => s.id === id))
      .filter(Boolean)
      .map((s) => ({ section: s.title }));
    return {
      ...a,
      orcid: authorOrcids[a.name] || undefined,
      affiliations: affNames.length ? affNames : undefined,
      section_contributions: sectionContribs.length ? sectionContribs : undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function ViewApp({ doi }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [commits, setCommits] = useState([]);
  const [selectedCommit, setSelectedCommit] = useState('');
  const [authors, setAuthors] = useState([]);
  const [projectTitle, setProjectTitle] = useState(doi);
  const previewRef = useRef(null);

  async function loadData(commit) {
    setLoading(true);
    setError(null);
    try {
      let url = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}`;
      if (commit) url += `&commit=${encodeURIComponent(commit)}`;
      const res = await fetch(url);
      if (res.status === 404) throw new Error(`Project "${doi}" not found.`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      setProjectTitle(data.project_name || doi);
      const rows = fromEndpointPayload(data);
      const meta = extractViewMeta(data);
      setAuthors(buildPreviewAuthors(rows, meta));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch(
        `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}&history=true`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data) ? data : (data.commits ?? data.history ?? []);
      setCommits(list);
      if (list.length) {
        const latest = list[0].commit ?? list[0].sha ?? list[0].hash ?? '';
        setSelectedCommit(latest);
      }
    } catch (_) {}
  }

  useEffect(() => {
    if (doi) { loadData(); fetchHistory(); }
  }, [doi]);

  useEffect(() => {
    if (previewRef.current && authors.length > 0) {
      createPreview(previewRef.current, authors);
    }
  }, [authors]);

  function onVersionChange(e) {
    const commit = e.target.value;
    setSelectedCommit(commit);
    loadData(commit);
  }

  if (!doi) {
    return html`<div class="contributions-view-page">
      <p class="cv-placeholder">No DOI or project name provided. <a href="/contributions">Go back</a>.</p>
    </div>`;
  }

  return html`
    <div class="contributions-view-page">
      <div class="cv-view-topbar">
        <h2 class="cv-view-title">${projectTitle}</h2>
        ${commits.length > 1 && html`
          <div class="cv-view-version-select">
            <label for="cv-version-select">Version:</label>
            <select id="cv-version-select" value=${selectedCommit} onChange=${onVersionChange}>
              ${commits.map((entry, i) => {
                const hash = entry.commit ?? entry.sha ?? entry.hash ?? '';
                const rawDate = entry.date ?? entry.committed_date ?? entry.timestamp ?? '';
                const date = rawDate ? new Date(rawDate) : null;
                const label = date && !isNaN(date)
                  ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  : (hash ? hash.slice(0, 8) : `v${i + 1}`);
                return html`<option key=${hash || i} value=${hash}>${label}${i === 0 ? ' (latest)' : ''}</option>`;
              })}
            </select>
          </div>
        `}
      </div>
      ${loading && html`<p class="cv-placeholder">Loading…</p>`}
      ${error && html`<p class="cv-placeholder" style="color:var(--color-danger)">${error}</p>`}
      ${!loading && !error && authors.length === 0 && html`
        <p class="cv-placeholder">No contributors found for this project.</p>
      `}
      <div ref=${previewRef} id="cv-preview-container" class="cv-view-preview"></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function createContributionsViewPage({ doi }) {
  const container = document.createElement('div');
  render(html`<${ViewApp} doi=${doi} />`, container);
  return container;
}
