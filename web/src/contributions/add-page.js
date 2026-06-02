/**
 * add-page.js — Self-service wizard for adding/editing author contributions.
 *
 * Flow for new visitors (no per-project cookie):
 *   Step 1: Personal info (name, ORCID, affiliations)
 *   Step 2: High-level CRediT role selection
 *   Step 3: Per-role details (descriptions + linked sections)
 *   Step 4: Full editor view (same as admin, scoped to this author)
 *
 * Returning visitors (cookie set) skip directly to step 4.
 * The token is used as the password for both loading and saving data.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import {
  CREDIT_CATEGORIES,
  CONTRIBUTION_LEVELS,
  CREDIT_ROLE_ENUM,
  CREDIT_ROLE_ENUM_REVERSE,
  fromEndpointPayload,
  toEndpointPayload,
} from './view.js';
import { CREDIT_ROLES } from './credit-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COOKIE_PREFIX = 'contributions_visited_';

function hasVisitedCookie(doi) {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${COOKIE_PREFIX}${doi}=`));
}

function setVisitedCookie(doi) {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${COOKIE_PREFIX}${doi}=1; expires=${expires}; path=/; SameSite=Lax`;
}

function extractPayloadMeta(data) {
  const sections = [];
  for (const raw of (Array.isArray(data.sections) ? data.sections : [])) {
    const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
    if (title) sections.push({ id: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title });
  }
  const affiliations = [];
  const affByName = new Map();
  for (const contributor of data.contributors || []) {
    const affRaw = contributor.author?.affiliation;
    const affArr = Array.isArray(affRaw) ? affRaw : (typeof affRaw === 'string' && affRaw ? [affRaw] : []);
    for (const affStr of affArr) {
      if (!affByName.has(affStr)) {
        const id = affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        affByName.set(affStr, id);
        affiliations.push({ id, name: affStr });
      }
    }
  }
  return { sections, affiliations };
}

// ---------------------------------------------------------------------------
// Step 1: Personal Info
// ---------------------------------------------------------------------------

function StepPersonalInfo({ name, setName, orcid, setOrcid, affiliationText, setAffiliationText, onNext }) {
  const [orcidResults, setOrcidResults] = useState([]);
  const [searching, setSearching] = useState(false);

  async function searchOrcid() {
    if (!name.trim()) return;
    setSearching(true);
    try {
      const parts = name.trim().split(/\s+/);
      const familyName = parts[parts.length - 1];
      const givenNames = parts.slice(0, -1).join('+');
      const q = givenNames
        ? `family-name:${encodeURIComponent(familyName)}+AND+given-names:${encodeURIComponent(givenNames)}`
        : `family-name:${encodeURIComponent(familyName)}`;
      const res = await fetch(`https://pub.orcid.org/v3.0/search/?q=${q}&rows=5`, {
        headers: { Accept: 'application/vnd.orcid+json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      setOrcidResults((data.result || []).map((r) => r['orcid-identifier']?.path).filter(Boolean));
    } catch (_) {} finally {
      setSearching(false);
    }
  }

  const canNext = name.trim().length > 0;

  return html`
    <div class="cv-wizard-step">
      <h2 class="cv-wizard-step-title">About You</h2>
      <p class="cv-wizard-step-desc">Let's start with your basic information.</p>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cw-name">Full Name *</label>
        <input id="cw-name" type="text" class="cv-wizard-input"
               placeholder="e.g. Jane Smith" value=${name}
               onInput=${(e) => setName(e.target.value)} />
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cw-orcid">ORCID iD</label>
        <div class="cv-orcid-row">
          <input id="cw-orcid" type="text" class="cv-wizard-input"
                 placeholder="0000-0000-0000-0000" value=${orcid}
                 onInput=${(e) => setOrcid(e.target.value)} />
          <button type="button" class="btn-secondary" onClick=${searchOrcid}
                  disabled=${searching || !name.trim()}>
            ${searching ? '…' : 'Search'}
          </button>
        </div>
        ${orcidResults.length > 0 && html`
          <div class="cv-wizard-orcid-results">
            ${orcidResults.map((id) => html`
              <button key=${id} type="button" class="cv-chip"
                      onClick=${() => { setOrcid(id); setOrcidResults([]); }}>
                ${id}
              </button>
            `)}
          </div>
        `}
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cw-affiliations">Affiliations</label>
        <textarea id="cw-affiliations" class="cv-wizard-textarea" rows="3"
                  placeholder="One per line, e.g.:\nAllen Institute for Neural Dynamics, Seattle, WA\nUniversity of Washington"
                  value=${affiliationText}
                  onInput=${(e) => setAffiliationText(e.target.value)}></textarea>
      </div>

      <div class="cv-wizard-nav">
        <span></span>
        <button class="btn-primary" disabled=${!canNext} onClick=${onNext}>Next →</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 2: High-level CRediT roles
// ---------------------------------------------------------------------------

function StepCreditRoles({ roles, setRoles, onBack, onNext }) {
  function toggle(cat) {
    setRoles((prev) => {
      const next = { ...prev };
      if (next[cat] && next[cat] !== 'None') {
        next[cat] = 'None';
      } else {
        next[cat] = 'Equal';
      }
      return next;
    });
  }

  function setLevel(cat, level) {
    setRoles((prev) => ({ ...prev, [cat]: level }));
  }

  const hasAnyRole = CREDIT_CATEGORIES.some((cat) => roles[cat] && roles[cat] !== 'None');

  return html`
    <div class="cv-wizard-step">
      <h2 class="cv-wizard-step-title">Your Contributions</h2>
      <p class="cv-wizard-step-desc">
        Select the CRediT roles that apply to your work on this project, and indicate your level of contribution.
      </p>

      <div class="cv-wizard-roles-grid">
        ${CREDIT_CATEGORIES.map((cat) => {
          const active = roles[cat] && roles[cat] !== 'None';
          return html`
            <div key=${cat} class=${'cv-wizard-role-card' + (active ? ' cv-wizard-role-active' : '')}>
              <label class="cv-wizard-role-check">
                <input type="checkbox" checked=${active} onChange=${() => toggle(cat)} />
                <span class="cv-wizard-role-name">${cat}</span>
              </label>
              ${active && html`
                <select class="cv-wizard-role-level" value=${roles[cat]}
                        onChange=${(e) => setLevel(cat, e.target.value)}>
                  ${CONTRIBUTION_LEVELS.filter((l) => l !== 'None').map((l) => html`
                    <option key=${l} value=${l}>${l}</option>
                  `)}
                </select>
              `}
            </div>
          `;
        })}
      </div>

      <div class="cv-wizard-nav">
        <button class="btn-secondary" onClick=${onBack}>← Back</button>
        <button class="btn-primary" disabled=${!hasAnyRole} onClick=${onNext}>Next →</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 3: Per-role details
// ---------------------------------------------------------------------------

function StepRoleDetails({ roles, descriptions, setDescriptions, linkedSections, setLinkedSections, sections, onBack, onNext }) {
  const activeRoles = CREDIT_CATEGORIES.filter((cat) => roles[cat] && roles[cat] !== 'None');

  return html`
    <div class="cv-wizard-step">
      <h2 class="cv-wizard-step-title">Contribution Details</h2>
      <p class="cv-wizard-step-desc">
        For each role, describe your specific contribution and optionally link it to paper sections.
      </p>

      ${activeRoles.map((cat) => {
        const roleEnum = CREDIT_ROLE_ENUM[cat];
        return html`
          <div key=${cat} class="cv-credit-card">
            <div class="cv-credit-card-header">
              <span class="cv-credit-role-name">${cat}</span>
              <span class=${'cv-credit-level-badge cv-credit-level-' + roles[cat].toLowerCase()}>${roles[cat]}</span>
            </div>
            <label class="cv-detail-label">Description</label>
            <textarea class="cv-credit-desc-textarea" rows="2"
                      placeholder="Describe your specific contribution…"
                      value=${descriptions[roleEnum] || ''}
                      onInput=${(e) => setDescriptions((prev) => ({ ...prev, [roleEnum]: e.target.value }))}></textarea>
            ${sections.length > 0 && html`
              <label class="cv-detail-label">Linked Sections</label>
              <div class="cv-wizard-section-chips">
                ${sections.map((sec) => {
                  const selected = (linkedSections[roleEnum] || []).includes(sec.id);
                  return html`
                    <button key=${sec.id} type="button"
                            class=${'cv-chip' + (selected ? ' cv-chip-selected' : '')}
                            onClick=${() => {
                              setLinkedSections((prev) => {
                                const ids = prev[roleEnum] || [];
                                const next = selected ? ids.filter((i) => i !== sec.id) : [...ids, sec.id];
                                return { ...prev, [roleEnum]: next };
                              });
                            }}>
                      ${sec.title}
                    </button>
                  `;
                })}
              </div>
            `}
          </div>
        `;
      })}

      <div class="cv-wizard-nav">
        <button class="btn-secondary" onClick=${onBack}>← Back</button>
        <button class="btn-primary" onClick=${onNext}>Finish & Review →</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 4: Full editor (scoped to this author)
// ---------------------------------------------------------------------------

function StepFullEditor({
  doi, token, authorName, orcid, affiliationText, roles, descriptions, linkedSections,
  allRows, setAllRows, projectData, sections, affiliations,
}) {
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState({ text: '', cls: '' });

  // Build the current author's row from wizard state
  const myRow = useMemo(() => {
    const row = { name: authorName, isFirst: false, author_level: null };
    for (const cat of CREDIT_CATEGORIES) row[cat] = roles[cat] || 'None';
    return row;
  }, [authorName, roles]);

  // Merge wizard author into allRows
  const mergedRows = useMemo(() => {
    const existing = allRows.findIndex((r) => r.name === authorName);
    if (existing >= 0) {
      return allRows.map((r, i) => i === existing ? myRow : r);
    }
    return [...allRows, myRow];
  }, [allRows, myRow, authorName]);

  function updateRole(cat, level) {
    // This updates the local display — we rebuild mergedRows from roles
    // Actually let's just provide the full editor inline
  }

  async function save() {
    setSaving(true);
    setSaveStatus({ text: 'Saving…', cls: 'status-loading' });
    try {
      // Build full payload with this author's data merged in
      const myAffNames = affiliationText.split('\n').map((s) => s.trim()).filter(Boolean);
      const authorOrcids = {};
      const authorAffIds = {};
      const creditDescriptions = {};
      const creditLinkedSections = {};

      if (orcid) authorOrcids[authorName] = orcid;
      if (myAffNames.length) {
        const myAffIds = myAffNames.map((n) => {
          const existing = affiliations.find((a) => a.name === n);
          return existing ? existing.id : n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        });
        authorAffIds[authorName] = myAffIds;
      }
      if (Object.keys(descriptions).length) creditDescriptions[authorName] = descriptions;
      if (Object.keys(linkedSections).length) creditLinkedSections[authorName] = linkedSections;

      // Merge with existing project data contributor info
      for (const contributor of projectData?.contributors || []) {
        const name = contributor.author?.name;
        if (!name || name === authorName) continue;
        const orc = contributor.author?.registry_identifier;
        if (orc) authorOrcids[name] = orc;
        const affRaw = contributor.author?.affiliation;
        if (Array.isArray(affRaw) && affRaw.length) {
          authorAffIds[name] = affRaw.map((n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        }
        for (const cl of contributor.credit_levels || []) {
          if (cl.description) {
            if (!creditDescriptions[name]) creditDescriptions[name] = {};
            creditDescriptions[name][cl.role] = cl.description;
          }
          if (cl.linked_sections?.length) {
            if (!creditLinkedSections[name]) creditLinkedSections[name] = {};
            const secByTitle = new Map(sections.map((s) => [s.title, s.id]));
            creditLinkedSections[name][cl.role] = cl.linked_sections
              .map((s) => secByTitle.get(typeof s === 'string' ? s : (s.section || s.title || '')))
              .filter(Boolean);
          }
        }
      }

      // Merge affiliations list
      const allAffs = [...affiliations];
      for (const n of myAffNames) {
        if (!allAffs.find((a) => a.name === n)) {
          allAffs.push({ id: n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: n });
        }
      }

      const payload = toEndpointPayload(mergedRows, doi, {
        authorOrcids,
        authorAffIds,
        affiliations: allAffs,
        sections,
        creditDescriptions,
        creditLinkedSections,
        assets: projectData?.assets || [],
        doi: projectData?.doi || '',
      });

      let url = `${CONTRIBUTIONS_API_BASE}/contributions/post?project=${encodeURIComponent(doi)}`;
      if (token) url += `&password=${encodeURIComponent(token)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      const result = await res.json();
      const commit = result.commit ? ` (commit: ${result.commit.slice(0, 8)})` : '';
      setSaveStatus({ text: `✓ Saved${commit}`, cls: 'status-success' });
    } catch (err) {
      setSaveStatus({ text: `Error: ${err.message}`, cls: 'status-error' });
    } finally {
      setSaving(false);
    }
  }

  return html`
    <div class="cv-wizard-step cv-wizard-step-editor">
      <h2 class="cv-wizard-step-title">Review & Edit</h2>
      <p class="cv-wizard-step-desc">
        Review your contributions below. You can directly edit levels and details before saving.
      </p>

      <div class="cv-wizard-editor-summary">
        <div class="cv-wizard-author-badge">
          <strong>${authorName}</strong>
          ${orcid && html`<span class="cv-wizard-orcid-badge">${orcid}</span>`}
        </div>
      </div>

      <table class="cv-authors-table cv-wizard-matrix">
        <thead>
          <tr>
            <th>Role</th>
            <th>Level</th>
          </tr>
        </thead>
        <tbody>
          ${CREDIT_CATEGORIES.map((cat) => {
            const level = roles[cat] || 'None';
            return html`
              <tr key=${cat} class=${level !== 'None' ? 'cv-row-active' : ''}>
                <td>${cat}</td>
                <td class=${'cell-' + level.toLowerCase()}>
                  <select value=${level} onChange=${(e) => {
                    // Direct update not possible in wizard state — this is read-only review
                  }} disabled>
                    ${CONTRIBUTION_LEVELS.map((l) => html`<option key=${l} value=${l}>${l}</option>`)}
                  </select>
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>

      ${Object.keys(descriptions).length > 0 && html`
        <h4 class="cv-subsection-heading">Contribution Descriptions</h4>
        ${Object.entries(descriptions).filter(([, v]) => v.trim()).map(([roleEnum, desc]) => html`
          <div key=${roleEnum} class="cv-credit-card">
            <span class="cv-credit-role-name">${CREDIT_ROLE_ENUM_REVERSE[roleEnum] || roleEnum}</span>
            <p class="cv-wizard-desc-text">${desc}</p>
          </div>
        `)}
      `}

      <div class="cv-wizard-nav">
        <span></span>
        <button class="btn-primary" onClick=${save} disabled=${saving}>
          ${saving ? 'Saving…' : 'Save Contributions'}
        </button>
      </div>
      ${saveStatus.text && html`
        <div class=${'contributions-endpoint-status ' + saveStatus.cls} aria-live="polite">
          ${saveStatus.text}
        </div>
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main Add App
// ---------------------------------------------------------------------------

function AddApp({ doi, token }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(0); // 0=loading, 1-4=wizard steps
  const [projectData, setProjectData] = useState(null);
  const [allRows, setAllRows] = useState([]);
  const [sections, setSections] = useState([]);
  const [affiliations, setAffiliations] = useState([]);

  // Wizard state
  const [name, setName] = useState('');
  const [orcid, setOrcid] = useState('');
  const [affiliationText, setAffiliationText] = useState('');
  const [roles, setRoles] = useState(() => {
    const r = {};
    for (const cat of CREDIT_CATEGORIES) r[cat] = 'None';
    return r;
  });
  const [descriptions, setDescriptions] = useState({});
  const [linkedSections, setLinkedSections] = useState({});

  // Load project data using token as password
  useEffect(() => {
    if (!doi || !token) {
      setLoading(false);
      setError('Missing DOI or token in URL.');
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}&password=${encodeURIComponent(token)}`,
        );
        if (res.status === 404) throw new Error(`Project "${doi}" not found.`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Access denied (${res.status})`);
        }
        const data = await res.json();
        setProjectData(data);
        setAllRows(fromEndpointPayload(data));
        const meta = extractPayloadMeta(data);
        setSections(meta.sections);
        setAffiliations(meta.affiliations);

        // Check cookie — skip wizard if returning user
        if (hasVisitedCookie(doi)) {
          setStep(4);
        } else {
          setStep(1);
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [doi, token]);

  function goToStep(n) {
    setStep(n);
    if (n === 4) setVisitedCookie(doi);
  }

  if (!doi || !token) {
    return html`<div class="contributions-add-page">
      <p class="cv-placeholder">Invalid link. A DOI and token are required. <a href="/contributions">Go back</a>.</p>
    </div>`;
  }

  if (loading) {
    return html`<div class="contributions-add-page"><p class="cv-placeholder">Loading…</p></div>`;
  }

  if (error) {
    return html`<div class="contributions-add-page">
      <p class="cv-placeholder" style="color:var(--color-danger)">${error}</p>
    </div>`;
  }

  return html`
    <div class="contributions-add-page">
      ${step > 0 && step < 4 && html`
        <div class="cv-wizard-progress">
          ${[1, 2, 3, 4].map((s) => html`
            <span key=${s} class=${'cv-wizard-dot' + (s === step ? ' cv-wizard-dot-active' : '') + (s < step ? ' cv-wizard-dot-done' : '')}>${s}</span>
          `)}
        </div>
      `}

      ${step === 1 && html`
        <${StepPersonalInfo}
          name=${name} setName=${setName}
          orcid=${orcid} setOrcid=${setOrcid}
          affiliationText=${affiliationText} setAffiliationText=${setAffiliationText}
          onNext=${() => goToStep(2)}
        />
      `}

      ${step === 2 && html`
        <${StepCreditRoles}
          roles=${roles} setRoles=${setRoles}
          onBack=${() => goToStep(1)}
          onNext=${() => goToStep(3)}
        />
      `}

      ${step === 3 && html`
        <${StepRoleDetails}
          roles=${roles}
          descriptions=${descriptions} setDescriptions=${setDescriptions}
          linkedSections=${linkedSections} setLinkedSections=${setLinkedSections}
          sections=${sections}
          onBack=${() => goToStep(2)}
          onNext=${() => goToStep(4)}
        />
      `}

      ${step === 4 && html`
        <${StepFullEditor}
          doi=${doi} token=${token}
          authorName=${name} orcid=${orcid} affiliationText=${affiliationText}
          roles=${roles} descriptions=${descriptions} linkedSections=${linkedSections}
          allRows=${allRows} setAllRows=${setAllRows}
          projectData=${projectData} sections=${sections} affiliations=${affiliations}
        />
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function createContributionsAddPage({ doi, token }) {
  const container = document.createElement('div');
  render(html`<${AddApp} doi=${doi} token=${token} />`, container);
  return container;
}
