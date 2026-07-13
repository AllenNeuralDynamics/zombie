/**
 * edit-page.js — Admin/member edit page for contributions.
 *
 * Access is gated by ORCID login (via the aind-metadata-viz backend):
 *   - Not logged in            → "Log in with ORCID" prompt.
 *   - Logged in, may edit       → the contributions editor (session-based save).
 *   - Logged in, no access      → "no access" prompt with the reason.
 *
 * Legacy fallback: projects that are still password-locked and for which the
 * user has no membership fall back to the original password modal so existing
 * locked projects keep working during the migration.
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { getCurrentUser, loginWithOrcid, logout } from '../lib/auth.js';
import { createContributionsView } from './view.js';

// ---------------------------------------------------------------------------
// Legacy password modal (kept for still-locked, unmigrated projects)
// ---------------------------------------------------------------------------

function PasswordModal({ doi, onUnlock }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!password.trim()) return;
    setChecking(true);
    setError('');
    try {
      const encoded = new TextEncoder().encode(password);
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
      const hashed = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      const res = await fetch(
        `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}&password=${encodeURIComponent(hashed)}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Invalid password');
      }
      onUnlock(password);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return html`
    <div class="cv-modal-backdrop">
      <div class="cv-modal">
        <h2 class="cv-modal-title">Project Locked</h2>
        <p class="cv-modal-desc">
          <strong>${doi}</strong> is password-protected. Enter the password to continue.
        </p>
        <form onSubmit=${submit}>
          <input ref=${inputRef} type="password" class="cv-modal-input"
                 placeholder="Password" value=${password}
                 onInput=${(e) => setPassword(e.target.value)} />
          ${error && html`<p class="cv-modal-error">${error}</p>`}
          <button type="submit" class="btn-primary cv-modal-btn"
                  disabled=${checking || !password.trim()}>
            ${checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  `;
}

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
          do not have edit access to <strong>${doi}</strong>. Ask the project
          admin for the invite link, then open it to add yourself.
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

// gate: 'loading' | 'login' | 'no-access' | 'password' | 'editor'
function EditApp({ doi }) {
  const [gate, setGate] = useState('loading');
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const passwordRef = useRef('');
  const editorRef = useRef(null);
  const [editorMounted, setEditorMounted] = useState(false);

  useEffect(() => {
    if (!doi) return;
    let cancelled = false;
    (async () => {
      const me = await getCurrentUser();
      if (cancelled) return;
      setUser(me);

      if (me) {
        // Logged in: does this user have edit access?
        try {
          const res = await fetch(
            `${CONTRIBUTIONS_API_BASE}/contributions/access?project=${encodeURIComponent(doi)}`,
            { credentials: 'include' },
          );
          const access = res.ok ? await res.json() : {};
          if (cancelled) return;
          setIsAdmin(!!access.is_admin);
          setGate(access.can_edit ? 'editor' : 'no-access');
        } catch (_) {
          if (!cancelled) setGate('no-access');
        }
        return;
      }

      // Not logged in: prefer ORCID login, but fall back to the legacy password
      // modal for projects that are still password-locked.
      try {
        const res = await fetch(
          `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}`,
        );
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setGate(data.locked === true ? 'password' : 'login');
        } else {
          // 404 (new project) or error → require login to create/edit.
          setGate('login');
        }
      } catch (_) {
        if (!cancelled) setGate('login');
      }
    })();
    return () => { cancelled = true; };
  }, [doi]);

  // Mount the editor once access is granted.
  useEffect(() => {
    if (gate !== 'editor' || editorMounted || !editorRef.current || !doi) return;
    const el = createContributionsView({
      projectName: doi,
      password: passwordRef.current,
      showTokenLinks: isAdmin,
    });
    editorRef.current.appendChild(el);
    setEditorMounted(true);
  }, [gate, doi, isAdmin, editorMounted]);

  function handleUnlock(pw) {
    passwordRef.current = pw;
    setGate('editor');
  }

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
  if (gate === 'password') return html`<${PasswordModal} doi=${doi} onUnlock=${handleUnlock} />`;

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
