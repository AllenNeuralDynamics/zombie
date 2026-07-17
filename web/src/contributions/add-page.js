/**
 * add-page.js — Self-service wizard for adding/editing author contributions.
 *
 * Reached from the /view "Edit" button (?project=…) by any non-admin. The
 * visitor logs in with ORCID and is matched to their own contributor row by
 * ORCID (adding a new row if they have none). Edit access is derived purely
 * from the contributor metadata on the backend — there is no invite token or
 * separate membership; a logged-in user may only add/edit their own row.
 *
 * Flow for new visitors (no per-project cookie):
 *   Step 1: Personal info (name, ORCID, affiliations)
 *   Step 2: High-level CRediT role selection
 *   Step 3: Per-role details (descriptions + linked sections)
 *   Step 4: Full editor view (same as admin, scoped to this author)
 *
 * Returning visitors (cookie set) and existing authors skip to the full editor.
 * Saves go through the ORCID session cookie. A visitor may also opt to continue
 * without logging in: their entry is saved, but they get no editable link back
 * and must ask an admin to make later changes.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { getCurrentUser, loginWithOrcid } from '../lib/auth.js';
import {
  CREDIT_CATEGORIES,
  CONTRIBUTION_LEVELS,
  LEVEL_DISPLAY,
  CREDIT_ROLE_ENUM,
  CREDIT_ROLE_ENUM_REVERSE,
  fromEndpointPayload,
  toEndpointPayload,
} from './view.js';
import { CREDIT_ROLES } from './credit-helpers.js';
import { RoleTip } from './role-tooltip.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COOKIE_PREFIX = 'contributions_visited_';

function cookieKey(doi) {
  return `${COOKIE_PREFIX}${doi}`;
}

function hasVisitedCookie(doi) {
  return document.cookie.split(';').some((c) => c.trim().startsWith(`${cookieKey(doi)}=`));
}

function setVisitedCookie(doi) {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${cookieKey(doi)}=1; expires=${expires}; path=/; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Draft persistence (localStorage, keyed by project)
// ---------------------------------------------------------------------------

const DRAFT_PREFIX = 'add_draft_';

function draftKey(id) {
  return DRAFT_PREFIX + encodeURIComponent(id).slice(0, 60);
}

function loadDraft(id) {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function saveDraft(id, state) {
  try { localStorage.setItem(draftKey(id), JSON.stringify(state)); } catch (_) {}
}

function clearDraft(id) {
  try { localStorage.removeItem(draftKey(id)); } catch (_) {}
}

function translateSaveError(msg) {
  const s = String(msg || '');
  if (/allows adding exactly one new author/i.test(s)) {
    return 'An author with this name already exists on the project. Pick a different name, or ask the lead author for a personal edit link.';
  }
  if (/cannot modify existing author/i.test(s)) {
    return 'Your one-time invite token can only add a new author — it cannot modify an existing one. Ask the lead author for a personal edit link to update an existing entry.';
  }
  if (/cannot remove existing authors/i.test(s)) {
    return 'Your token does not have permission to remove existing authors.';
  }
  return s;
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

function StepPersonalInfo({ name, setName, orcid, setOrcid, selectedAffNames, setSelectedAffNames, projectAffiliations, joinDate, setJoinDate, leaveDate, setLeaveDate, onNext }) {
  const [orcidResults, setOrcidResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [customAff, setCustomAff] = useState('');

  function toggleAff(affName) {
    setSelectedAffNames((prev) =>
      prev.includes(affName) ? prev.filter((n) => n !== affName) : [...prev, affName]
    );
  }

  function addCustom() {
    const trimmed = customAff.trim();
    if (!trimmed) return;
    setSelectedAffNames((prev) => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    setCustomAff('');
  }

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
              <span key=${id} class="cv-orcid-result-row">
                <button type="button" class="cv-chip"
                        onClick=${() => { setOrcid(id); setOrcidResults([]); }}>
                  ${id}
                </button>
                <a href=${`https://orcid.org/${id}`} target="_blank" rel="noopener noreferrer"
                   class="cv-orcid-verify-link" title="Verify on orcid.org">verify ↗</a>
              </span>
            `)}
          </div>
        `}
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label">Affiliations</label>
        ${projectAffiliations.length > 0 && html`
          <div class="cv-wizard-aff-list">
            ${projectAffiliations.map((aff) => html`
              <label key=${aff.id} class="cv-wizard-aff-item">
                <input type="checkbox" checked=${selectedAffNames.includes(aff.name)}
                       onChange=${() => toggleAff(aff.name)} />
                <span>${aff.name}</span>
              </label>
            `)}
          </div>
        `}
        ${selectedAffNames.filter((n) => !projectAffiliations.find((a) => a.name === n)).map((n) => html`
          <div key=${n} class="cv-wizard-custom-aff-tag">
            <span>${n}</span>
            <button type="button" class="cv-x-btn" onClick=${() => toggleAff(n)}>×</button>
          </div>
        `)}
        <div class="cv-wizard-aff-add-row">
          <input type="text" class="cv-wizard-input"
                 placeholder="Add affiliation not listed above…"
                 value=${customAff}
                 onInput=${(e) => setCustomAff(e.target.value)}
                 onKeyDown=${(e) => e.key === 'Enter' && addCustom()} />
          <button type="button" class="btn-secondary" onClick=${addCustom}
                  disabled=${!customAff.trim()}>Add</button>
        </div>
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cw-join-date">Join Date (optional)</label>
        <input id="cw-join-date" type="date" class="cv-wizard-input"
               value=${joinDate || ''}
               onInput=${(e) => setJoinDate(e.target.value || null)} />
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cw-leave-date">End Date (optional)</label>
        <input id="cw-leave-date" type="date" class="cv-wizard-input"
               value=${leaveDate || ''}
               onInput=${(e) => setLeaveDate(e.target.value || null)} />
      </div>

      <div class="cv-wizard-nav">
        <span></span>
        <button class="btn-primary" disabled=${!canNext} onClick=${onNext}>Next →</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Shared sidebar: level definitions
// ---------------------------------------------------------------------------

const ALLEN_AUTHORSHIP_URL = 'https://alleninstitute.sharepoint.com/sites/AC-Science-Innovation/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FAC%2DScience%2DInnovation%2FShared%20Documents%2Fauthorship%5Fguidelines%2Epdf&parent=%2Fsites%2FAC%2DScience%2DInnovation%2FShared%20Documents';

function LevelDefinitionsSidebar() {
  return html`
    <aside class="cv-level-sidebar">
      <h3 class="cv-level-sidebar-heading">Level definitions</h3>
      <p class="cv-level-sidebar-intro">
        Levels are optional, you can leave your contribution as the default or choose from the following options:
      </p>
      <ul class="cv-level-sidebar-list">
        <li><strong>++</strong> indicates a major contribution to a specific CRediT role</li>
        <li><strong>+</strong> indicates a supporting contribution, which may not warrant authorship</li>
        <li><strong>Lead</strong> indicates that the author was both a major contributor and the primary coordinator of this CRediT role, not all papers have authors at the lead level</li>
      </ul>
      <p class="cv-level-sidebar-guidelines">
        Please also see the Allen Institute guidelines and appendix for further details:${' '}
        <a href=${ALLEN_AUTHORSHIP_URL} target="_blank" rel="noopener noreferrer">Allen Institute Authorship Guidelines</a>
      </p>
    </aside>
  `;
}

// ---------------------------------------------------------------------------
// Step 2: High-level CRediT roles
// ---------------------------------------------------------------------------

function StepCreditRoles({ roles, setRoles, onBack, onNext, allowLead, allowLevels }) {
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
  const levelOptions = CONTRIBUTION_LEVELS.filter((l) => {
    if (l === 'None') return false;
    if (l === 'Lead' && !allowLead) return false;
    return true;
  });

  return html`
    <div class="cv-wizard-layout">
      <div class="cv-wizard-step">
        <h2 class="cv-wizard-step-title">Your Contributions</h2>
        <p class="cv-wizard-step-desc">
          Select the CRediT roles that apply to your work on this project${allowLevels ? ', and indicate your level of contribution' : ''}.
        </p>

        <div class="cv-wizard-roles-grid">
          ${CREDIT_CATEGORIES.map((cat) => {
            const active = roles[cat] && roles[cat] !== 'None';
            return html`
              <div key=${cat} class=${'cv-wizard-role-card' + (active ? ' cv-wizard-role-active' : '')}
                   onClick=${() => toggle(cat)}>
                <label class="cv-wizard-role-check" onClick=${(e) => e.stopPropagation()}>
                  <input type="checkbox" checked=${active} onChange=${() => toggle(cat)} />
                  <span class="cv-wizard-role-name"><${RoleTip} name=${cat} /></span>
                </label>
                ${active && allowLevels && html`
                  <select class="cv-wizard-role-level" value=${roles[cat]}
                          onClick=${(e) => e.stopPropagation()}
                          onChange=${(e) => setLevel(cat, e.target.value)}>
                    ${levelOptions.map((l) => html`
                      <option key=${l} value=${l}>${LEVEL_DISPLAY[l] || l}</option>
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
      <${LevelDefinitionsSidebar} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 3: Per-role details
// ---------------------------------------------------------------------------

function StepRoleDetails({ roles, descriptions, setDescriptions, onBack, onNext, allowLevels }) {
  const activeRoles = CREDIT_CATEGORIES.filter((cat) => roles[cat] && roles[cat] !== 'None');

  return html`
    <div class="cv-wizard-step">
      <h2 class="cv-wizard-step-title">Contribution Details</h2>
      <p class="cv-wizard-step-desc">
        For each role, describe your specific contribution (optional)
      </p>

      ${activeRoles.map((cat) => {
        const roleEnum = CREDIT_ROLE_ENUM[cat];
        return html`
          <div key=${cat} class="cv-credit-card">
            <div class="cv-credit-card-header">
              <span class="cv-credit-role-name"><${RoleTip} name=${cat} /></span>
              ${allowLevels && html`<span class=${'cv-credit-level-badge cv-credit-level-' + roles[cat].toLowerCase()}>${roles[cat]}</span>`}
            </div>
            <label class="cv-detail-label">Description</label>
            <textarea class="cv-credit-desc-textarea" rows="2"
                      placeholder="Describe your specific contribution…"
                      value=${descriptions[roleEnum] || ''}
                      onInput=${(e) => setDescriptions((prev) => ({ ...prev, [roleEnum]: e.target.value }))}></textarea>
          </div>
        `;
      })}

      <div class="cv-wizard-nav">
        <button class="btn-secondary" onClick=${onBack}>← Back</button>
        <button class="btn-primary" onClick=${onNext}>Next →</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 4: Sections (only shown when sections exist)
// ---------------------------------------------------------------------------

function StepSections({ sections, sectionLevels, setSectionLevels, onBack, onNext, allowLead, allowLevels }) {
  function getLevel(title) {
    return sectionLevels[title]?.level || 'None';
  }
  function getDescription(title) {
    return sectionLevels[title]?.description || '';
  }
  function setLevel(title, level) {
    setSectionLevels((prev) => {
      if (!level || level === 'None') {
        const next = { ...prev };
        delete next[title];
        return next;
      }
      return { ...prev, [title]: { level, description: prev[title]?.description || '' } };
    });
  }
  function setDescription(title, description) {
    setSectionLevels((prev) => ({
      ...prev,
      [title]: { level: prev[title]?.level || 'equal', description },
    }));
  }
  function toggle(title) {
    const current = getLevel(title);
    if (current && current !== 'None') setLevel(title, 'None');
    else setLevel(title, 'equal');
  }

  const levelOptions = [
    ...(allowLead ? [{ value: 'lead', label: 'Lead' }] : []),
    { value: 'equal', label: '++' },
    { value: 'supporting', label: '+' },
  ];

  return html`
    <div class="cv-wizard-layout">
      <div class="cv-wizard-step">
        <h2 class="cv-wizard-step-title">Section Contributions</h2>
        <p class="cv-wizard-step-desc">
          Check the sections you contributed to${allowLevels ? ', and indicate your level of contribution' : ''}.
        </p>

        ${sections.map((sec) => {
          const level = getLevel(sec.title);
          const active = level !== 'None';
          const description = getDescription(sec.title);
          return html`
            <div key=${sec.id} class="cv-section-contrib-row">
              <label class="cv-section-contrib-check">
                <input type="checkbox" checked=${active} onChange=${() => toggle(sec.title)} />
                <span class="cv-section-contrib-title">${sec.title}</span>
              </label>
              ${active && allowLevels && html`
                <select class="cv-section-contrib-level"
                        value=${level}
                        onChange=${(e) => setLevel(sec.title, e.target.value)}>
                  ${levelOptions.map((opt) => html`
                    <option key=${opt.value} value=${opt.value}>${opt.label}</option>
                  `)}
                </select>
              `}
              ${active && html`
                <input type="text" class="cv-section-contrib-desc"
                       placeholder="Description (optional)"
                       value=${description}
                       onInput=${(e) => setDescription(sec.title, e.target.value)} />
              `}
            </div>
          `;
        })}

        <div class="cv-wizard-nav">
          <button class="btn-secondary" onClick=${onBack}>← Back</button>
          <button class="btn-primary" onClick=${onNext}>Next →</button>
        </div>
      </div>
      <${LevelDefinitionsSidebar} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 5: Full editor (scoped to this author)
// ---------------------------------------------------------------------------

function StepFullEditor({
  doi, draftId, anonymous, authorName, orcid, selectedAffNames, roles, descriptions, joinDate, leaveDate, sectionLevels,
  setAuthorName, setOrcid, setSelectedAffNames, setRoles, setDescriptions, setJoinDate, setLeaveDate, setSectionLevels,
  allRows, projectData, sections, affiliations, onBack, allowLead, allowLevels,
}) {
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState({ text: '', cls: '' });

  const [editName, setEditName]               = useState(authorName);
  const [editOrcid, setEditOrcid]             = useState(orcid);
  const [editAffNames, setEditAffNames]       = useState(selectedAffNames);
  const [editRoles, setEditRoles]             = useState(() => ({ ...roles }));
  const [editDescs, setEditDescs]             = useState(() => ({ ...descriptions }));
  const [editJoinDate, setEditJoinDate]       = useState(joinDate || null);
  const [editLeaveDate, setEditLeaveDate]     = useState(leaveDate || null);
  const [editSectionLevels, setEditSectionLevels] = useState(() => ({ ...sectionLevels }));
  const [customAff, setCustomAff]             = useState('');

  useEffect(() => { setAuthorName?.(editName); }, [editName]);
  useEffect(() => { setOrcid?.(editOrcid); }, [editOrcid]);
  useEffect(() => { setSelectedAffNames?.(editAffNames); }, [editAffNames]);
  useEffect(() => { setRoles?.(editRoles); }, [editRoles]);
  useEffect(() => { setDescriptions?.(editDescs); }, [editDescs]);
  useEffect(() => { setJoinDate?.(editJoinDate); }, [editJoinDate]);
  useEffect(() => { setLeaveDate?.(editLeaveDate); }, [editLeaveDate]);
  useEffect(() => { setSectionLevels?.(editSectionLevels); }, [editSectionLevels]);

  function toggleAff(affName) {
    setEditAffNames((prev) =>
      prev.includes(affName) ? prev.filter((n) => n !== affName) : [...prev, affName]
    );
  }
  function addCustomAff() {
    const t = customAff.trim();
    if (!t) return;
    setEditAffNames((prev) => prev.includes(t) ? prev : [...prev, t]);
    setCustomAff('');
  }

  function getSectionLevel(title) { return editSectionLevels[title]?.level || 'None'; }
  function getSectionDescription(title) { return editSectionLevels[title]?.description || ''; }
  function updateSectionLevel(title, level) {
    setEditSectionLevels((prev) => {
      if (!level || level === 'None') { const n = { ...prev }; delete n[title]; return n; }
      return { ...prev, [title]: { level, description: prev[title]?.description || '' } };
    });
  }
  function toggleSection(title) {
    const current = getSectionLevel(title);
    if (current && current !== 'None') updateSectionLevel(title, 'None');
    else updateSectionLevel(title, 'equal');
  }
  function updateSectionDescription(title, description) {
    setEditSectionLevels((prev) => ({
      ...prev,
      [title]: { level: prev[title]?.level || 'equal', description },
    }));
  }

  const activeRoles = CREDIT_CATEGORIES.filter((cat) => editRoles[cat] && editRoles[cat] !== 'None');

  const sectionLevelOptions = [
    ...(allowLead ? [{ value: 'lead', label: 'Lead' }] : []),
    { value: 'equal', label: '++' },
    { value: 'supporting', label: '+' },
  ];

  const myRow = useMemo(() => {
    const row = { name: editName.trim() || authorName, isFirst: false, author_level: null };
    for (const cat of CREDIT_CATEGORIES) row[cat] = editRoles[cat] || 'None';
    return row;
  }, [editName, authorName, editRoles]);

  const mergedRows = useMemo(() => {
    const nameKey = editName.trim() || authorName;
    const existing = allRows.findIndex((r) => r.name === nameKey || r.name === authorName);
    if (existing >= 0) {
      return allRows.map((r, i) => i === existing ? myRow : r);
    }
    return [...allRows, myRow];
  }, [allRows, myRow, editName, authorName]);

  async function save() {
    setSaving(true);
    setSaveStatus({ text: 'Saving…', cls: 'status-loading' });
    try {
      const myAffNames = editAffNames;
      const authorOrcids = {};
      const authorAffIds = {};
      const creditDescriptions = {};
      const authorStartDates = {};
      const authorEndDates = {};
      const authorSectionLevels = {};

      const finalName = editName.trim() || authorName;
      if (editOrcid) authorOrcids[finalName] = editOrcid;
      if (myAffNames.length) {
        const myAffIds = myAffNames.map((n) => {
          const existing = affiliations.find((a) => a.name === n);
          return existing ? existing.id : n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        });
        authorAffIds[finalName] = myAffIds;
      }
      if (Object.keys(editDescs).length) creditDescriptions[finalName] = editDescs;
      if (editJoinDate) authorStartDates[finalName] = editJoinDate;
      if (editLeaveDate) authorEndDates[finalName] = editLeaveDate;
      const mySectionLevels = Object.entries(editSectionLevels)
        .filter(([, v]) => v.level && v.level !== 'None')
        .map(([section, v]) => ({ section, level: v.level, ...(v.description ? { description: v.description } : {}) }));
      if (mySectionLevels.length) authorSectionLevels[finalName] = mySectionLevels;

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
        }
        if (contributor.start_date) authorStartDates[name] = contributor.start_date;
        if (contributor.end_date) authorEndDates[name] = contributor.end_date;
        if (contributor.section_levels?.length) authorSectionLevels[name] = contributor.section_levels;
      }

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
        authorStartDates,
        authorEndDates,
        authorSectionLevels,
        assets: projectData?.assets || [],
        doi: projectData?.doi || '',
      });

      // Members/admins save via their ORCID session cookie. Anonymous
      // submitters rely on the project being publicly writable; no editable
      // link is issued to them.
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/post?project=${encodeURIComponent(doi)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const raw = body.error || `Server error ${res.status}`;
        const friendly = translateSaveError(raw);
        throw new Error(friendly);
      }
      const result = await res.json();
      const commit = result.commit ? ` (commit: ${result.commit.slice(0, 8)})` : '';
      setSaveStatus({ text: `✓ Saved${commit}`, cls: 'status-success' });
      clearDraft(draftId);
      setTimeout(() => {
        window.location.href = `/contributions/view?doi=${encodeURIComponent(doi)}`;
      }, 1200);
    } catch (err) {
      setSaveStatus({ text: `Error: ${err.message}`, cls: 'status-error' });
    } finally {
      setSaving(false);
    }
  }

  return html`
    <div class="cv-wizard-layout">
      <div class="cv-wizard-step cv-wizard-step-editor">
        <h2 class="cv-wizard-step-title">Review & Edit</h2>
        <p class="cv-wizard-step-desc">Edit anything below before saving.</p>

        ${anonymous && html`
          <div class="cv-anon-warning" role="alert">
            <strong>You are not logged in.</strong> Your contribution will be
            saved, but you won't be able to come back and edit it later. To make
            changes after submitting, you'll have to contact a project admin.
            Log in with ORCID instead if you want to keep editing access.
          </div>
        `}

        <h3 class="cv-subsection-heading">Your Information</h3>

        <div class="cv-wizard-field">
          <label class="cv-detail-label" for="cwe-name">Full Name *</label>
          <input id="cwe-name" type="text" class="cv-wizard-input"
                 value=${editName} onInput=${(e) => setEditName(e.target.value)} />
        </div>

        <div class="cv-wizard-field">
          <label class="cv-detail-label" for="cwe-orcid">ORCID iD</label>
          <input id="cwe-orcid" type="text" class="cv-wizard-input"
                 placeholder="0000-0000-0000-0000"
                 value=${editOrcid} onInput=${(e) => setEditOrcid(e.target.value)} />
        </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cwe-join-date">Join Date (optional)</label>
        <input id="cwe-join-date" type="date" class="cv-wizard-input"
               value=${editJoinDate || ''}
               onInput=${(e) => setEditJoinDate(e.target.value || null)} />
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label" for="cwe-leave-date">End Date (optional)</label>
        <input id="cwe-leave-date" type="date" class="cv-wizard-input"
               value=${editLeaveDate || ''}
               onInput=${(e) => setEditLeaveDate(e.target.value || null)} />
      </div>

      <div class="cv-wizard-field">
        <label class="cv-detail-label">Affiliations</label>
        ${affiliations.length > 0 && html`
          <div class="cv-wizard-aff-list">
            ${affiliations.map((aff) => html`
              <label key=${aff.id} class="cv-wizard-aff-item">
                <input type="checkbox" checked=${editAffNames.includes(aff.name)}
                       onChange=${() => toggleAff(aff.name)} />
                <span>${aff.name}</span>
              </label>
            `)}
          </div>
        `}
        ${editAffNames.filter((n) => !affiliations.find((a) => a.name === n)).map((n) => html`
          <div key=${n} class="cv-wizard-custom-aff-tag">
            <span>${n}</span>
            <button type="button" class="cv-x-btn" onClick=${() => toggleAff(n)}>×</button>
          </div>
        `)}
        <div class="cv-wizard-aff-add-row">
          <input type="text" class="cv-wizard-input"
                 placeholder="Add affiliation not listed above…"
                 value=${customAff}
                 onInput=${(e) => setCustomAff(e.target.value)}
                 onKeyDown=${(e) => e.key === 'Enter' && addCustomAff()} />
          <button type="button" class="btn-secondary" onClick=${addCustomAff}
                  disabled=${!customAff.trim()}>Add</button>
        </div>
      </div>

      <h3 class="cv-subsection-heading">Contribution Roles</h3>
      <div class="cv-wizard-roles-grid" style="margin-bottom:20px">
        ${CREDIT_CATEGORIES.map((cat) => {
          const active = editRoles[cat] && editRoles[cat] !== 'None';
          const levelOptions = CONTRIBUTION_LEVELS.filter((l) => {
            if (l === 'None') return false;
            if (l === 'Lead' && !allowLead) return false;
            return true;
          });
          return html`
            <div key=${cat} class=${'cv-wizard-role-card' + (active ? ' cv-wizard-role-active' : '')}
                 onClick=${() => setEditRoles((prev) => ({ ...prev, [cat]: prev[cat] && prev[cat] !== 'None' ? 'None' : 'Equal' }))}>
              <label class="cv-wizard-role-check" onClick=${(e) => e.stopPropagation()}>
                <input type="checkbox" checked=${active}
                       onChange=${() => setEditRoles((prev) => ({ ...prev, [cat]: prev[cat] && prev[cat] !== 'None' ? 'None' : 'Equal' }))} />
                <span class="cv-wizard-role-name"><${RoleTip} name=${cat} /></span>
              </label>
              ${active && allowLevels && html`
                <select class="cv-wizard-role-level" value=${editRoles[cat]}
                        onClick=${(e) => e.stopPropagation()}
                        onChange=${(e) => setEditRoles((prev) => ({ ...prev, [cat]: e.target.value }))}>
                  ${levelOptions.map((l) => html`
                    <option key=${l} value=${l}>${LEVEL_DISPLAY[l] || l}</option>
                  `)}
                </select>
              `}
            </div>
          `;
        })}
      </div>

      ${activeRoles.length > 0 && html`
        <h3 class="cv-subsection-heading">Contribution Details</h3>
        ${activeRoles.map((cat) => {
          const roleEnum = CREDIT_ROLE_ENUM[cat];
          return html`
            <div key=${cat} class="cv-credit-card">
              <div class="cv-credit-card-header">
                <span class="cv-credit-role-name"><${RoleTip} name=${cat} /></span>
                ${allowLevels && html`<span class=${'cv-credit-level-badge cv-credit-level-' + editRoles[cat].toLowerCase()}>${LEVEL_DISPLAY[editRoles[cat]] || editRoles[cat]}</span>`}
              </div>
              <label class="cv-detail-label">Description</label>
              <textarea class="cv-credit-desc-textarea" rows="2"
                        placeholder="Describe your specific contribution…"
                        onInput=${(e) => setEditDescs((prev) => ({ ...prev, [roleEnum]: e.target.value }))}>
                ${editDescs[roleEnum] || ''}
              </textarea>
            </div>
          `;
        })}
      `}

      ${sections.length > 0 && html`
        <h3 class="cv-subsection-heading">Section Contributions</h3>
        ${sections.map((sec) => {
          const level = getSectionLevel(sec.title);
          const active = level !== 'None';
          const description = getSectionDescription(sec.title);
          return html`
            <div key=${sec.id} class="cv-section-contrib-row">
              <label class="cv-section-contrib-check">
                <input type="checkbox" checked=${active} onChange=${() => toggleSection(sec.title)} />
                <span class="cv-section-contrib-title">${sec.title}</span>
              </label>
              ${active && allowLevels && html`
                <select class="cv-section-contrib-level"
                        value=${level}
                        onChange=${(e) => updateSectionLevel(sec.title, e.target.value)}>
                  ${sectionLevelOptions.map((opt) => html`
                    <option key=${opt.value} value=${opt.value}>${opt.label}</option>
                  `)}
                </select>
              `}
              ${active && html`
                <input type="text" class="cv-section-contrib-desc"
                       placeholder="Description (optional)"
                       value=${description}
                       onInput=${(e) => updateSectionDescription(sec.title, e.target.value)} />
              `}
            </div>
          `;
        })}
      `}

      <div class="cv-wizard-nav">
        <button class="btn-secondary" onClick=${onBack}>← Back</button>
        <button class="btn-primary" onClick=${save} disabled=${saving || !editName.trim()}>
          ${saving ? 'Saving…' : 'Save Contributions'}
        </button>
      </div>
      ${saveStatus.text && html`
        <div class=${'contributions-endpoint-status ' + saveStatus.cls} aria-live="polite">
          ${saveStatus.text}
        </div>
      `}
      </div>
      <${LevelDefinitionsSidebar} />
    </div>
  `;
}
// ---------------------------------------------------------------------------
// Main Add App
// ---------------------------------------------------------------------------

function AddApp({ project, doi, existingAuthor }) {
  // The /view "Edit" button links here with just `project`. The logged-in user
  // is recognised by their session and matched to their own row on load.
  const effProject = project || doi;
  const draftId = effProject;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [step, setStep] = useState(0);
  const [projectData, setProjectData] = useState(null);
  const [allRows, setAllRows] = useState([]);
  const [sections, setSections] = useState([]);
  const [affiliations, setAffiliations] = useState([]);
  // Auth gate: 'checking' | 'login' | 'joining' | 'ready'
  const [authGate, setAuthGate] = useState('checking');
  const [user, setUser] = useState(null);
  // True when the visitor opted to continue without logging in: their entry is
  // saved but they are given no way to edit it later.
  const [anonymous, setAnonymous] = useState(false);

  const _draft = loadDraft(draftId);
  const isExisting = Boolean(existingAuthor);

  const [name, setName] = useState(_draft?.name || (isExisting ? existingAuthor : ''));
  const [orcid, setOrcid] = useState(_draft?.orcid || '');
  const [selectedAffNames, setSelectedAffNames] = useState(_draft?.selectedAffNames || []);
  const [joinDate, setJoinDate] = useState(_draft?.joinDate || null);
  const [leaveDate, setLeaveDate] = useState(_draft?.leaveDate || null);
  const [roles, setRoles] = useState(() => {
    if (_draft?.roles) return _draft.roles;
    const r = {};
    for (const cat of CREDIT_CATEGORIES) r[cat] = 'None';
    return r;
  });
  const [descriptions, setDescriptions] = useState(_draft?.descriptions || {});
  const [sectionLevels, setSectionLevels] = useState(_draft?.sectionLevels || {});
  const [prefilled, setPrefilled] = useState(Boolean(_draft));

  useEffect(() => {
    if (loading) return;
    saveDraft(draftId, { step, name, orcid, selectedAffNames, joinDate, leaveDate, roles, descriptions, sectionLevels });
  }, [step, name, orcid, selectedAffNames, joinDate, leaveDate, roles, descriptions, sectionLevels, loading]);

  // Require ORCID login (with an opt-out). The logged-in user is recognised by
  // their session and matched to their own row on load; edit access is derived
  // from the contributor metadata on the backend (no invite token).
  useEffect(() => {
    if (!effProject) { setAuthGate('ready'); return; }
    let cancelled = false;
    (async () => {
      const me = await getCurrentUser();
      if (cancelled) return;
      setUser(me);
      if (!me) { setAuthGate('login'); return; }
      setAuthGate('ready');
    })();
    return () => { cancelled = true; };
  }, [effProject]);

  useEffect(() => {
    if (authGate !== 'ready') return;
    if (!effProject) {
      setLoading(false);
      setError('Missing project in URL.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Contribution data is publicly readable; no password/token needed.
        const getUrl = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(effProject)}`;
        const res = await fetch(getUrl, { credentials: 'include' });
        if (cancelled) return;
        if (res.status === 404) throw new Error(`Project "${effProject}" not found.`);
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

        // Which existing row belongs to this visitor? A logged-in user is
        // matched by their ORCID; otherwise fall back to the author name in the
        // URL (legacy prefill hint).
        const contributors = data.contributors || [];
        let ownContributor = null;
        if (user?.orcid) {
          ownContributor = contributors.find(
            (c) => c.author?.registry_identifier
              && c.author.registry_identifier === user.orcid,
          ) || null;
        }
        if (!ownContributor && existingAuthor) {
          ownContributor = contributors.find((c) => c.author?.name === existingAuthor) || null;
        }

        // Default the ORCID/name fields to the logged-in identity so a newly
        // created record is tied to their account (and stays editable later).
        if (user?.orcid && !_draft?.orcid) setOrcid(user.orcid);
        if (user?.name && !_draft?.name && !ownContributor && !existingAuthor) setName(user.name);

        if (ownContributor && !_draft && !prefilled) {
          setName(ownContributor.author.name);
          const existingOrcid = ownContributor.author?.registry_identifier || '';
          if (existingOrcid) setOrcid(existingOrcid);

          const affRaw = ownContributor.author?.affiliation;
          const affArr = Array.isArray(affRaw) ? affRaw
            : (typeof affRaw === 'string' && affRaw ? [affRaw] : []);
          if (affArr.length) setSelectedAffNames(affArr);

          if (ownContributor.start_date) setJoinDate(ownContributor.start_date);
          if (ownContributor.end_date) setLeaveDate(ownContributor.end_date);

          const newRoles = {};
          for (const cat of CREDIT_CATEGORIES) newRoles[cat] = 'None';
          const newDescs = {};
          for (const cl of ownContributor.credit_levels || []) {
            const displayRole = CREDIT_ROLE_ENUM_REVERSE[cl.role];
            if (displayRole) {
              newRoles[displayRole] = cl.level.charAt(0).toUpperCase() + cl.level.slice(1);
            }
            if (cl.description) newDescs[cl.role] = cl.description;
          }
          setRoles(newRoles);
          if (Object.keys(newDescs).length) setDescriptions(newDescs);

          if (ownContributor.section_levels?.length) {
            const newSectionLevels = {};
            for (const sl of ownContributor.section_levels) {
              newSectionLevels[sl.section] = { level: sl.level, description: sl.description || '' };
            }
            setSectionLevels(newSectionLevels);
          }

          setPrefilled(true);
        }

        if (_draft?.step) {
          setStep(_draft.step);
        } else if (ownContributor || hasVisitedCookie(effProject)) {
          setStep(5);
        } else {
          setStep(1);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authGate, effProject]);

  function goToStep(n) {
    setStep(n);
    if (n === 5) setVisitedCookie(effProject);
  }

  function goNextFromRoleDetails() {
    if (sections.length > 0) {
      goToStep(4);
    } else {
      goToStep(5);
    }
  }

  const totalWizardSteps = sections.length > 0 ? 4 : 3;

  if (!effProject) {
    return html`<div class="contributions-add-page">
      <p class="cv-placeholder">Invalid link. A project is required. <a href="/contributions">Go back</a>.</p>
    </div>`;
  }

  // Prompt for login before joining/editing. Show any join error too, and let
  // the visitor opt out of logging in (they then can't edit later).
  if (authGate === 'login') {
    return html`<div class="contributions-add-page">
      <div class="cv-modal">
        <h2 class="cv-modal-title">Log in to continue</h2>
        <p class="cv-modal-desc">
          Sign in with your ORCID account to add yourself to
          <strong>${effProject}</strong>. Logging in ties this contribution to
          your account so you can come back and edit it any time.
        </p>
        ${error && html`<p class="cv-modal-error">${error}</p>`}
        <button class="btn-primary cv-modal-btn" onClick=${() => loginWithOrcid()}>
          Log in with ORCID
        </button>
        <p class="cv-modal-desc cv-anon-optout">
          Don't want to log in? You can still add your contribution, but
          <strong>you won't be able to edit it later</strong> without asking a
          project admin.
        </p>
        <button class="btn-secondary cv-modal-btn"
                onClick=${() => { setError(null); setAnonymous(true); setAuthGate('ready'); }}>
          Continue without logging in
        </button>
      </div>
    </div>`;
  }

  if (authGate === 'checking' || loading) {
    return html`<div class="contributions-add-page"><p class="cv-placeholder">Loading…</p></div>`;
  }

  if (error) {
    return html`<div class="contributions-add-page">
      <p class="cv-placeholder" style="color:var(--color-danger)">${error}</p>
    </div>`;
  }

  const allowLead   = projectData?.allow_lead   ?? true;
  const allowLevels = projectData?.allow_levels ?? true;

  return html`
    <div class="contributions-add-page">
      ${step > 0 && step < 5 && html`
        <div class="cv-wizard-progress">
          ${Array.from({ length: totalWizardSteps }, (_, i) => i + 1).map((s) => html`
            <span key=${s} class=${'cv-wizard-dot' + (s === step ? ' cv-wizard-dot-active' : '') + (s < step ? ' cv-wizard-dot-done' : '')}>${s}</span>
          `)}
        </div>
      `}

      ${step === 1 && html`
        <${StepPersonalInfo}
          name=${name} setName=${setName}
          orcid=${orcid} setOrcid=${setOrcid}
          selectedAffNames=${selectedAffNames} setSelectedAffNames=${setSelectedAffNames}
          projectAffiliations=${affiliations}
          joinDate=${joinDate} setJoinDate=${setJoinDate}
          leaveDate=${leaveDate} setLeaveDate=${setLeaveDate}
          onNext=${() => goToStep(2)}
        />
      `}

      ${step === 2 && html`
        <${StepCreditRoles}
          roles=${roles} setRoles=${setRoles}
          onBack=${() => goToStep(1)}
          onNext=${() => goToStep(3)}
          allowLead=${allowLead} allowLevels=${allowLevels}
        />
      `}

      ${step === 3 && html`
        <${StepRoleDetails}
          roles=${roles}
          descriptions=${descriptions} setDescriptions=${setDescriptions}
          onBack=${() => goToStep(2)}
          onNext=${goNextFromRoleDetails}
          allowLevels=${allowLevels}
        />
      `}

      ${step === 4 && html`
        <${StepSections}
          sections=${sections}
          sectionLevels=${sectionLevels} setSectionLevels=${setSectionLevels}
          onBack=${() => goToStep(3)}
          onNext=${() => goToStep(5)}
          allowLead=${allowLead} allowLevels=${allowLevels}
        />
      `}

      ${step === 5 && html`
        <${StepFullEditor}
          doi=${effProject} draftId=${draftId} anonymous=${anonymous}
          authorName=${name} orcid=${orcid} selectedAffNames=${selectedAffNames}
          roles=${roles} descriptions=${descriptions}
          joinDate=${joinDate} leaveDate=${leaveDate} sectionLevels=${sectionLevels}
          setAuthorName=${setName} setOrcid=${setOrcid} setSelectedAffNames=${setSelectedAffNames}
          setRoles=${setRoles} setDescriptions=${setDescriptions}
          setJoinDate=${setJoinDate} setLeaveDate=${setLeaveDate} setSectionLevels=${setSectionLevels}
          allRows=${allRows}
          projectData=${projectData} sections=${sections} affiliations=${affiliations}
          onBack=${() => goToStep(sections.length > 0 ? 4 : 3)}
          allowLead=${allowLead} allowLevels=${allowLevels}
        />
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function createContributionsAddPage({ project = '', doi, author = '' }) {
  const container = document.createElement('div');
  render(
    html`<${AddApp} project=${project} doi=${doi} existingAuthor=${author} />`,
    container,
  );
  return container;
}
