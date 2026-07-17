/**
 * edit-page.js — Admin-only full editor for contributions.
 *
 * Access is gated by ORCID login (via the aind-metadata-viz backend):
 *   - Not logged in   → "Log in with ORCID" prompt.
 *   - Admin           → the full contributions editor (session-based save).
 *   - Logged in, not admin → "no access" prompt pointing at the add page.
 *
 * "Admin" means a global admin (ADMIN_ORCIDS) or a contributor whose ORCID is
 * flagged is_admin on this project. Non-admins edit their own author row via
 * the add wizard. There is no password login and no separate membership.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { getCurrentUser, loginWithOrcid, logout } from '../lib/auth.js';
import { createContributionsView } from './view.js';

// ---------------------------------------------------------------------------
// Login / access gates
// ---------------------------------------------------------------------------

function LoginGate({ doi }) {
  return html`
    <div class="cv-modal-backdrop">
      <div class="cv-modal">
        <h2 class="cv-modal-title">Log in to edit</h2>
        <p class="cv-modal-desc">
          Editing <strong>${doi}</strong> requires logging in. Sign in with your
          ORCID account to continue.
        </p>
        <button class="btn-primary cv-modal-btn" onClick=${() => loginWithOrcid()}>
          Log in with ORCID
        </button>
      </div>
    </div>
  `;
}

function NoAccessGate({ doi, user }) {
  return html`
    <div class="cv-modal-backdrop">
      <div class="cv-modal">
        <h2 class="cv-modal-title">No access</h2>
        <p class="cv-modal-desc">
          You are logged in as <strong>${user?.name || user?.orcid}</strong> but
          are not an admin of <strong>${doi}</strong>, so you can't open the full
          editor. To add or update your own author entry, use the
          <a href=${`/contributions/add?project=${encodeURIComponent(doi)}`}>add page</a>.
          A project admin can grant you admin access from the editor.
        </p>
        <button class="btn-secondary cv-modal-btn"
                onClick=${() => logout(() => window.location.reload())}>
          Log out
        </button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Edit Page App
// ---------------------------------------------------------------------------

// gate: 'loading' | 'login' | 'no-access' | 'editor'
function EditApp({ doi }) {
  const [gate, setGate] = useState('loading');
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const editorRef = useRef(null);
  const [editorMounted, setEditorMounted] = useState(false);

  useEffect(() => {
    if (!doi) return;
    let cancelled = false;
    (async () => {
      const me = await getCurrentUser();
      if (cancelled) return;
      setUser(me);

      if (!me) {
        setGate('login');
        return;
      }

      // Logged in: does this user have edit access?
      try {
        const res = await fetch(
          `${CONTRIBUTIONS_API_BASE}/contributions/access?project=${encodeURIComponent(doi)}`,
          { credentials: 'include' },
        );
        const access = res.ok ? await res.json() : {};
        if (cancelled) return;
        if (access.is_admin) {
          setIsAdmin(true);
          setGate('editor');
          return;
        }

        // Not an admin. Two cases:
        //   * Project exists  → full editor is admin-only → no access (they use
        //     the add wizard for their own row instead).
        //   * Project doesn't exist yet → this is the creator: let them build it.
        //     They become admin automatically on the first save (backend).
        const getRes = await fetch(
          `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}`,
        );
        if (cancelled) return;
        if (getRes.status === 404) {
          setIsAdmin(true);
          setGate('editor');
        } else {
          setGate('no-access');
        }
      } catch (_) {
        if (!cancelled) setGate('no-access');
      }
    })();
    return () => { cancelled = true; };
  }, [doi]);

  // Mount the editor once access is granted.
  useEffect(() => {
    if (gate !== 'editor' || editorMounted || !editorRef.current || !doi) return;
    const el = createContributionsView({
      projectName: doi,
      isAdmin,
    });
    editorRef.current.appendChild(el);
    setEditorMounted(true);
  }, [gate, doi, isAdmin, editorMounted]);

  if (!doi) {
    return html`<div class="contributions-edit-page">
      <p class="cv-placeholder">No DOI or project name provided. <a href="/contributions">Go back</a>.</p>
    </div>`;
  }

  if (gate === 'loading') {
    return html`<div class="contributions-edit-page"><p class="cv-placeholder">Loading…</p></div>`;
  }
  if (gate === 'login') return html`<${LoginGate} doi=${doi} />`;
  if (gate === 'no-access') return html`<${NoAccessGate} doi=${doi} user=${user} />`;

  return html`
    <div class="contributions-edit-page">
      <div ref=${editorRef}></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function createContributionsEditPage({ doi }) {
  const container = document.createElement('div');
  render(html`<${EditApp} doi=${doi} />`, container);
  return container;
}
