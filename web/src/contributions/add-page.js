/**
 * add-page.js — Self-service wizard for adding/editing author contributions.
 *
 * Reached from the /view "Edit" button (?project=…) by any non-admin. The
 * visitor logs in with ORCID and is matched to their own contributor row by
 * ORCID (adding a new row if they have none). Edit access is derived purely
 * from the contributor metadata on the backend — there is no invite token or
 * separate membership; a logged-in user may only add/edit their own row.
 * Local Vite development skips the login screen and disables server saves.
 *
 * Flow for new visitors (no per-project cookie): Profile, Roles & details,
 * optional Sections, then the full shared author editor.
 *
 * Returning visitors (cookie set) and existing authors skip to the full editor.
 * Saves go through the ORCID session cookie. A visitor may also opt to continue
 * without logging in: their entry is saved, but they get no editable link back
 * and must ask an admin to make later changes.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { getCurrentUser, loginWithOrcid } from '../lib/auth.js';
import { isLocalDevelopment } from '../lib/local-dev.js';
import {
  CREDIT_CATEGORIES,
  CREDIT_ROLE_ENUM,
  CREDIT_ROLE_ENUM_REVERSE,
  fromEndpointPayload,
  toEndpointPayload,
  authorNameExists,
} from './view.js';
import {
  AuthorEditor,
  AuthorProfileSection,
  AuthorRolesSection,
  AuthorSectionsSection,
} from './author-editor.js';

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

function translateSaveError(msg, anonymous) {
  const s = String(msg || '');
  // The backend rejects a scope violation with "only add/edit your own author
  // entry". For an anonymous submitter there is no identity to own a row, so
  // the only thing they can do is append one new entry — never edit or remove.
  if (/only (add|edit) your own author entry/i.test(s)) {
    if (anonymous) {
      return 'Without logging in you can only add one new author entry — you can’t edit or remove existing entries. Log in with ORCID to make other changes.';
    }
    return 'You can only add or edit your own author entry. Ask a project admin to make other changes.';
  }
  if (/admin can lock or unlock/i.test(s) || /admin can grant or change admin access/i.test(s)) {
    return 'Only a project admin can change lock or admin settings.';
  }
  if (/project is locked/i.test(s)) {
    return 'This project is locked; ask an admin to unlock it before editing.';
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
// Step 1: Profile
// ---------------------------------------------------------------------------

function StepPersonalInfo({
  name, setName, orcid, setOrcid, email, setEmail, selectedAffNames, setSelectedAffNames,
  projectAffiliations, joinDate, setJoinDate, leaveDate, setLeaveDate, onNext,
}) {
  const canNext = name.trim().length > 0;

  return html`
    <div class="cv-wizard-step">
      <h2 class="cv-wizard-step-title">About You</h2>
      <p class="cv-wizard-step-desc">Let's start with your basic information.</p>
      <${AuthorProfileSection}
        idPrefix="cw"
        name=${name} orcid=${orcid} email=${email}
        startDate=${joinDate} endDate=${leaveDate}
        affiliations=${projectAffiliations}
        selectedAffiliationNames=${selectedAffNames}
        onChange=${(field, value) => {
          if (field === 'name') setName(value);
          else if (field === 'orcid') setOrcid(value);
          else if (field === 'email') setEmail(value);
          else if (field === 'startDate') setJoinDate(value);
          else if (field === 'endDate') setLeaveDate(value);
        }}
        onAffiliationsChange=${setSelectedAffNames}
      />

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

function LevelDefinitionsSidebar({ allowLead = true, allowLevels = true }) {
  if (!allowLevels) return null;
  return html`
    <aside class="cv-level-sidebar">
      <h3 class="cv-level-sidebar-heading">Level definitions</h3>
      <p class="cv-level-sidebar-intro">
        Levels are optional, you can leave your contribution as the default or choose from the following options:
      </p>
      <ul class="cv-level-sidebar-list">
        <li><strong>++</strong> indicates a major contribution to a specific CRediT role</li>
        <li><strong>+</strong> indicates a supporting contribution, which may not warrant authorship</li>
        ${allowLead && html`<li><strong>Lead</strong> indicates that the author was both a major contributor and the primary coordinator of this CRediT role, not all papers have authors at the lead level</li>`}
      </ul>
      <p class="cv-level-sidebar-guidelines">
        Please also see the Allen Institute guidelines and appendix for further details:${' '}
        <a href=${ALLEN_AUTHORSHIP_URL} target="_blank" rel="noopener noreferrer">Allen Institute Authorship Guidelines</a>
      </p>
    </aside>
  `;
}

// ---------------------------------------------------------------------------
// Step 2: CRediT roles and descriptions
// ---------------------------------------------------------------------------

function StepCreditRoles({ roles, setRoles, descriptions, setDescriptions, onBack, onNext, allowLead, allowLevels }) {
  const hasAnyRole = CREDIT_CATEGORIES.some((cat) => roles[cat] && roles[cat] !== 'None');

  return html`
    <div class="cv-wizard-layout">
      <div class="cv-wizard-step">
        <h2 class="cv-wizard-step-title">Your Contributions</h2>
        <p class="cv-wizard-step-desc">
          Select the CRediT roles that apply to your work on this project and add any details.
        </p>
        <${AuthorRolesSection}
          roles=${roles} descriptions=${descriptions}
          allowLead=${allowLead} allowLevels=${allowLevels}
          onRoleChange=${(role, level) => setRoles((prev) => ({
            ...prev, [role]: level === 'none' || level === 'None'
              ? 'None' : level[0].toUpperCase() + level.slice(1),
          }))}
          onDescriptionChange=${(role, value) => setDescriptions((prev) => ({
            ...prev, [CREDIT_ROLE_ENUM[role]]: value,
          }))}
        />

        <div class="cv-wizard-nav">
          <button class="btn-secondary" onClick=${onBack}>← Back</button>
          <button class="btn-primary" disabled=${!hasAnyRole} onClick=${onNext}>Next →</button>
        </div>
      </div>
      <${LevelDefinitionsSidebar} allowLead=${allowLead} allowLevels=${allowLevels} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Step 3: Sections (only shown when sections exist)
// ---------------------------------------------------------------------------

function StepSections({ sections, sectionLevels, setSectionLevels, onBack, onNext, allowLead, allowLevels }) {
  return html`
    <div class="cv-wizard-layout">
      <div class="cv-wizard-step">
        <h2 class="cv-wizard-step-title">Section Contributions</h2>
        <p class="cv-wizard-step-desc">
          Check the sections you contributed to${allowLevels ? ', and indicate your level of contribution' : ''}.
        </p>

        <${AuthorSectionsSection}
          sections=${sections} sectionLevels=${sectionLevels}
          allowLead=${allowLead} allowLevels=${allowLevels}
          onSectionChange=${(title, level, description) => setSectionLevels((prev) => {
            if (!level || level === 'none') {
              const next = { ...prev };
              delete next[title];
              return next;
            }
            return { ...prev, [title]: { level, description } };
          })}
        />

        <div class="cv-wizard-nav">
          <button class="btn-secondary" onClick=${onBack}>← Back</button>
          <button class="btn-primary" onClick=${onNext}>Next →</button>
        </div>
      </div>
      <${LevelDefinitionsSidebar} allowLead=${allowLead} allowLevels=${allowLevels} />
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Full editor (scoped to this author)
// ---------------------------------------------------------------------------

function StepFullEditor({
  doi, draftId, anonymous, authorName, ownAuthorName,
  orcid, email, selectedAffNames, roles, descriptions, joinDate, leaveDate, sectionLevels,
  setAuthorName, setOrcid, setEmail, setSelectedAffNames, setRoles, setDescriptions, setJoinDate, setLeaveDate, setSectionLevels,
  allRows, sections, affiliations, onBack, allowLead, allowLevels,
}) {
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState({ text: '', cls: '' });
  const localPreview = isLocalDevelopment();
  const finalName = authorName.trim() || ownAuthorName;
  const nameCollision = anonymous && authorNameExists(allRows, finalName);

  async function save() {
    if (localPreview) {
      setSaveStatus({ text: 'Local preview — server saving is disabled.', cls: 'status-info' });
      return;
    }
    setSaving(true);
    setSaveStatus({ text: 'Saving…', cls: 'status-loading' });
    try {
      const authorOrcids = {};
      const authorEmails = {};
      const authorAffIds = {};
      const creditDescriptions = {};
      const authorStartDates = {};
      const authorEndDates = {};
      const authorSectionLevels = {};
      if (orcid) authorOrcids[finalName] = orcid;
      if (email.trim()) authorEmails[finalName] = email.trim();
      if (selectedAffNames.length) {
        authorAffIds[finalName] = selectedAffNames.map((name) => {
          const existing = affiliations.find((affiliation) => affiliation.name === name);
          return existing ? existing.id : name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        });
      }
      if (Object.keys(descriptions).length) creditDescriptions[finalName] = descriptions;
      if (joinDate) authorStartDates[finalName] = joinDate;
      if (leaveDate) authorEndDates[finalName] = leaveDate;
      const mySectionLevels = Object.entries(sectionLevels)
        .filter(([, contribution]) => contribution.level && contribution.level !== 'None' && contribution.level !== 'none')
        .map(([section, contribution]) => ({
          section,
          level: contribution.level,
          ...(contribution.description ? { description: contribution.description } : {}),
        }));
      if (mySectionLevels.length) authorSectionLevels[finalName] = mySectionLevels;

      const allAffiliations = [...affiliations];
      for (const name of selectedAffNames) {
        if (!allAffiliations.some((affiliation) => affiliation.name === name)) {
          allAffiliations.push({
            id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            name,
          });
        }
      }

      // The self-service endpoint accepts only this author's contributor object.
      const ownRow = { name: finalName, isFirst: false, author_level: null };
      for (const category of CREDIT_CATEGORIES) ownRow[category] = roles[category] || 'None';
      const storedOwnRow = allRows.find(
        (row) => row.name === ownAuthorName || row.name === finalName,
      );
      const [authorPayload] = toEndpointPayload([{
        ...ownRow,
        ...(storedOwnRow?._passthrough ? { _passthrough: storedOwnRow._passthrough } : {}),
      }], doi, {
        authorOrcids,
        authorEmails,
        authorAffIds,
        affiliations: allAffiliations,
        sections,
        creditDescriptions,
        authorStartDates,
        authorEndDates,
        authorSectionLevels,
      }).contributors;

      const url = `${CONTRIBUTIONS_API_BASE}/contributions/author?project=${encodeURIComponent(doi)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authorPayload),
        credentials: 'include',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(translateSaveError(body.error || `Server error ${response.status}`, anonymous));
      }
      const result = await response.json();
      const commit = result.commit ? ` (commit: ${result.commit.slice(0, 8)})` : '';
      setSaveStatus({ text: `✓ Saved${commit}`, cls: 'status-success' });
      clearDraft(draftId);
      setTimeout(() => {
        window.location.href = `/contributions/view?doi=${encodeURIComponent(doi)}`;
      }, 1200);
    } catch (error) {
      setSaveStatus({ text: `Error: ${error.message}`, cls: 'status-error' });
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
        ${nameCollision && html`
          <div class="cv-anon-warning" role="alert">
            <strong>“${finalName}” already exists on this project.</strong>
            Without logging in you can only add a new author. Use a different
            name, or contact a project admin to update that entry.
          </div>
        `}
        <${AuthorEditor}
          idPrefix="cwe"
          authorName=${authorName}
          orcid=${orcid}
          email=${email}
          startDate=${joinDate}
          endDate=${leaveDate}
          affiliations=${affiliations}
          selectedAffiliationNames=${selectedAffNames}
          roles=${roles}
          descriptions=${descriptions}
          sections=${sections}
          sectionLevels=${sectionLevels}
          allowLead=${allowLead}
          allowLevels=${allowLevels}
          onProfileChange=${(field, value) => {
            if (field === 'name') setAuthorName(value);
            else if (field === 'orcid') setOrcid(value);
            else if (field === 'email') setEmail(value);
            else if (field === 'startDate') setJoinDate(value);
            else if (field === 'endDate') setLeaveDate(value);
          }}
          onAffiliationsChange=${setSelectedAffNames}
          onRoleChange=${(role, level) => setRoles((prev) => ({
            ...prev, [role]: level === 'none' || level === 'None'
              ? 'None' : level[0].toUpperCase() + level.slice(1),
          }))}
          onDescriptionChange=${(role, value) => setDescriptions((prev) => ({
            ...prev, [CREDIT_ROLE_ENUM[role]]: value,
          }))}
          onSectionChange=${(title, level, description) => setSectionLevels((prev) => {
            if (!level || level === 'none') {
              const next = { ...prev };
              delete next[title];
              return next;
            }
            return { ...prev, [title]: { level, description } };
          })}
        />
        <div class="cv-wizard-nav">
          <button class="btn-secondary" onClick=${onBack}>← Back</button>
          <button class="btn-primary" onClick=${save}
                  disabled=${localPreview || saving || !finalName || nameCollision}>
            ${localPreview ? 'Local preview' : saving ? 'Saving…' : 'Save Contributions'}
          </button>
        </div>
        ${saveStatus.text && html`
          <div class=${'contributions-endpoint-status ' + saveStatus.cls} aria-live="polite">
            ${saveStatus.text}
          </div>
        `}      </div>
      <${LevelDefinitionsSidebar} allowLead=${allowLead} allowLevels=${allowLevels} />
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
  const [ownAuthorName, setOwnAuthorName] = useState(
    _draft?.ownAuthorName || _draft?.name || (isExisting ? existingAuthor : ''),
  );
  const [orcid, setOrcid] = useState(_draft?.orcid || '');
  const [email, setEmail] = useState(_draft?.email || '');
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
    saveDraft(draftId, { step, name, ownAuthorName, orcid, email, selectedAffNames, joinDate, leaveDate, roles, descriptions, sectionLevels });
  }, [step, name, ownAuthorName, orcid, email, selectedAffNames, joinDate, leaveDate, roles, descriptions, sectionLevels, loading]);

  // Require ORCID login (with an opt-out). The logged-in user is recognised by
  // their session and matched to their own row on load; edit access is derived
  // from the contributor metadata on the backend (no invite token).
  useEffect(() => {
    if (!effProject) { setAuthGate('ready'); return; }
    let cancelled = false;
    (async () => {
      if (isLocalDevelopment()) {
        setAuthGate('ready');
        return;
      }

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
        const getUrl = `${CONTRIBUTIONS_API_BASE}/contributions/project?project=${encodeURIComponent(effProject)}`;
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
        if (ownContributor) setOwnAuthorName(ownContributor.author.name);
        if (user?.orcid && !_draft?.orcid) setOrcid(user.orcid);
        if (user?.name && !_draft?.name && !ownContributor && !existingAuthor) {
          setName(user.name);
          setOwnAuthorName(user.name);
        }

        if (ownContributor && !_draft && !prefilled) {
          setName(ownContributor.author.name);
          const existingOrcid = ownContributor.author?.registry_identifier || '';
          if (existingOrcid) setOrcid(existingOrcid);
          const existingEmail = ownContributor.author?.email || '';
          if (existingEmail) setEmail(existingEmail);

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
          const legacyStep = _draft.step;
          setStep(legacyStep === 3 || legacyStep === 4
            ? (meta.sections.length > 0 ? 4 : 5)
            : legacyStep);
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

  function goNextFromRoles() {
    if (sections.length > 0) {
      goToStep(4);
    } else {
      goToStep(5);
    }
  }

  const wizardSteps = sections.length > 0 ? [1, 2, 4] : [1, 2];
  const activeWizardStep = wizardSteps.indexOf(step);

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
          ${wizardSteps.map((wizardStep, index) => html`
            <span key=${wizardStep} class=${'cv-wizard-dot' + (index === activeWizardStep ? ' cv-wizard-dot-active' : '') + (index < activeWizardStep ? ' cv-wizard-dot-done' : '')}>${index + 1}</span>
          `)}
        </div>
      `}

      ${step === 1 && html`
        <${StepPersonalInfo}
          name=${name} setName=${setName}
          orcid=${orcid} setOrcid=${setOrcid}
          email=${email} setEmail=${setEmail}
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
          descriptions=${descriptions} setDescriptions=${setDescriptions}
          onBack=${() => goToStep(1)}
          onNext=${goNextFromRoles}
          allowLead=${allowLead} allowLevels=${allowLevels}
        />
      `}

      ${step === 4 && html`
        <${StepSections}
          sections=${sections}
          sectionLevels=${sectionLevels} setSectionLevels=${setSectionLevels}
          onBack=${() => goToStep(2)}
          onNext=${() => goToStep(5)}
          allowLead=${allowLead} allowLevels=${allowLevels}
        />
      `}

      ${step === 5 && html`
        <${StepFullEditor}
          doi=${effProject} draftId=${draftId} anonymous=${anonymous}
          authorName=${name} ownAuthorName=${ownAuthorName}
          orcid=${orcid} email=${email} selectedAffNames=${selectedAffNames}
          roles=${roles} descriptions=${descriptions}
          joinDate=${joinDate} leaveDate=${leaveDate} sectionLevels=${sectionLevels}
          setAuthorName=${setName} setOrcid=${setOrcid} setEmail=${setEmail} setSelectedAffNames=${setSelectedAffNames}
          setRoles=${setRoles} setDescriptions=${setDescriptions}
          setJoinDate=${setJoinDate} setLeaveDate=${setLeaveDate} setSectionLevels=${setSectionLevels}
          allRows=${allRows}
          sections=${sections} affiliations=${affiliations}
          onBack=${() => goToStep(sections.length > 0 ? 4 : 2)}
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
