/**
 * combined/view.js — Merged Project + Subject page.
 *
 * Renders the existing Project view and Subject view stacked inside two
 * collapsible <details> sections:
 *
 *   ┌ Project ───────────────────────────────┐  (top, collapsible)
 *   │  …existing project overview…           │
 *   └────────────────────────────────────────┘
 *   ┌ Subject ───────────────────────────────┐  (bottom, collapsible)
 *   │  …existing subject viewer…             │
 *   └────────────────────────────────────────┘
 *
 * Navigation rules:
 *   - ?subject_id=<id>  → open Subject section, collapse Project.
 *   - ?project=<name>   → open Project section, collapse Subject.
 *     (?project_name= is accepted as an alias on the way in.)
 *   - Clicking a subject (label / asset row / acquisition dot) on the Project
 *     timeline opens the Subject section and loads that subject — jumping to
 *     the clicked acquisition when one is known.
 *   - Clicking a project link on the Subject card opens the Project section and
 *     loads that project.
 *   - Expanding the Project section while it is empty loads the project from the
 *     subject's most-recent asset.
 *
 * The combined view owns the URL; the embedded child views run with
 * `embedded: true` and do not touch history themselves.
 */

import { createProjectView } from '../project/view.js';
import { createSubjectView } from '../subject/view.js';
import { queryRows } from '../lib/arrow.js';

/**
 * Resolve an asset-only deep link through the canonical asset index.
 *
 * `/view` is subject-centric, but asset links are also valid entry points.
 * Keep this lookup in the combined view so the URL owner can add the resolved
 * subject_id before loading the embedded subject view.  SWDB membership tables
 * are intentionally not consulted here: only canonical asset_basics rows can
 * establish the subject relationship for this page.
 *
 * @param {object|null} coordinator
 * @param {string} assetName
 * @returns {Promise<string|null>}
 */
export async function resolveAssetSubject(coordinator, assetName) {
  if (!coordinator || !assetName) return null;
  const safeAssetName = String(assetName).replace(/'/g, "''");
  const rows = await queryRows(
    coordinator,
    `SELECT subject_id::VARCHAR AS subject_id
       FROM asset_basics
      WHERE name = '${safeAssetName}'
        AND subject_id IS NOT NULL
      LIMIT 1`,
  );
  const subjectId = rows[0]?.subject_id;
  return subjectId == null ? null : String(subjectId);
}

export function createCombinedView(opts = {}) {
  const { coordinator } = opts;

  const params = new URLSearchParams(window.location.search);
  const initialProject = params.get('project') ?? params.get('project_name') ?? '';
  const initialSubject = params.get('subject_id') ?? '';
  const initialAsset = params.get('asset') ?? '';

  // Open project if project param present; open subject if subject param present.
  // Neither set → project opens as default.
  const projectOpen = !!initialProject || !initialSubject;
  const subjectOpen = !!initialSubject;

  const root = document.createElement('div');
  root.className = 'combined-view';

  // ── State ──────────────────────────────────────────────────────────────────
  let projectLoaded = !!initialProject;        // has the project view loaded a project?
  let pendingProjectName = initialProject || null; // project to load on first expand
  let currentSubject = initialSubject || '';
  let currentProject = initialProject || '';
  let currentAsset = initialAsset || '';
  let _preserveAsset = !!initialAsset;

  // ── Section scaffolding ──────────────────────────────────────────────────
  const { details: projectDetails, body: projectBody } =
    buildSection('Project', projectOpen);
  const { details: subjectDetails, body: subjectBody } =
    buildSection('Subject', subjectOpen);

  root.appendChild(projectDetails);
  root.appendChild(subjectDetails);

  // ── URL sync ───────────────────────────────────────────────────────────────
  function syncUrl() {
    const p = new URLSearchParams(window.location.search);
    if (currentProject) p.set('project', currentProject); else p.delete('project');
    p.delete('project_name');
    if (currentSubject) p.set('subject_id', currentSubject); else p.delete('subject_id');
    if (currentAsset) p.set('asset', currentAsset); else p.delete('asset');
    try {
      const url = new URL(window.location.href);
      url.search = p.toString();
      history.replaceState({}, '', url);
    } catch { /* restricted context */ }
  }

  // ── Subject view ─────────────────────────────────────────────────────────
  const subjectView = createSubjectView({
    coordinator,
    embedded: true,
    initialAcquisition: initialAsset || null,
    onSubjectLoaded: ({ subjectId, mostRecentProject }) => {
      currentSubject = subjectId || '';
      if (!_preserveAsset) currentAsset = '';
      _preserveAsset = false;
      if (!projectLoaded && mostRecentProject) pendingProjectName = mostRecentProject;
      projectView.highlightSubject?.(subjectId || null);
      syncUrl();
    },
    onAcquisitionSelect: (assetName, { programmatic = false } = {}) => {
      // A deep link may name a derived asset, which the timeline resolves to the
      // acquisition it descends from. Don't rewrite ?asset= to that ancestor —
      // keep what the user asked for until they pick a bubble themselves.
      const keepDeepLink = programmatic && currentAsset && currentAsset !== assetName;
      if (!keepDeepLink) currentAsset = assetName || '';
      syncUrl();
      projectView.highlightAsset?.(currentAsset);
    },
  });
  subjectBody.appendChild(subjectView);

  // ── Project view ───────────────────────────────────────────────────────────
  const projectView = createProjectView({
    coordinator,
    embedded: true,
    onSubjectClick: (subjectId, { acquisitionName } = {}) => {
      openSubject(subjectId, { acquisitionName });
    },
  });
  projectBody.appendChild(projectView);

  // ── Cross-navigation interception ──────────────────────────────────────────
  // Subject labels & asset-table subject links inside the Project view.
  projectView.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[href*="subject_id="]');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href') ?? (typeof link.href === 'string' ? link.href : null);
    const id = paramFromHref(href, 'subject_id');
    if (id) openSubject(id, { scroll: true });
  });

  // Project links inside the Subject view (info card "Projects" list).
  subjectView.addEventListener('click', (e) => {
    const link = e.target.closest?.('a[href*="/view"]');
    if (!link) return;
    const name = paramFromHref(link.href, 'project') ?? paramFromHref(link.href, 'project_name');
    if (!name) return;
    e.preventDefault();
    openProject(name);
  });

  // Asset-only links are valid deep links. Resolve the canonical asset row,
  // then load its subject and keep the requested asset selected. Do this after
  // both child views exist so a late lookup cannot race their construction.
  if (!initialSubject && initialAsset && coordinator) {
    resolveAssetSubject(coordinator, initialAsset)
      .then((subjectId) => {
        // The user may have navigated elsewhere while the lookup was running.
        if (!subjectId || currentSubject || currentAsset !== initialAsset) return;
        openSubject(subjectId, { acquisitionName: initialAsset });
      })
      .catch((err) => {
        console.warn('[CombinedView] Failed to resolve asset subject:', err);
      });
  }

  // ── Lazy project load on first expand ──────────────────────────────────────
  projectDetails.addEventListener('toggle', () => {
    if (projectDetails.open && !projectLoaded && pendingProjectName) {
      projectLoaded = true;
      currentProject = pendingProjectName;
      projectView.loadProject?.(pendingProjectName);
      syncUrl();
    }
  });

  // ── Imperative helpers ───────────────────────────────────────────────────
  function openSubject(subjectId, { acquisitionName, scroll = false } = {}) {
    subjectDetails.open = true;
    currentSubject = subjectId || '';
    currentAsset = acquisitionName || '';
    _preserveAsset = !!acquisitionName;
    projectView.highlightAsset?.(acquisitionName ?? null);
    subjectView.loadSubject?.(subjectId, { acquisitionName });
    syncUrl();
    if (scroll) {
      requestAnimationFrame(() =>
        subjectDetails.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  }

  function openProject(name) {
    projectDetails.open = true;
    projectLoaded = true;
    currentProject = name || '';
    pendingProjectName = name || null;
    projectView.loadProject?.(name);
    syncUrl();
  }

  syncUrl();
  return root;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSection(title, open) {
  const details = document.createElement('details');
  details.className = 'combined-section';
  details.open = open;

  const summary = document.createElement('summary');
  summary.className = 'combined-section-summary';
  summary.textContent = title;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'combined-section-body';
  details.appendChild(body);

  return { details, body };
}

function paramFromHref(href, key) {
  try {
    return new URL(href, window.location.origin).searchParams.get(key);
  } catch {
    return null;
  }
}
