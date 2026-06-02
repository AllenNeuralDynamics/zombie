/**
 * edit-page.js — Admin edit page for contributions.
 *
 * Wraps the existing contributions editor (createContributionsView) and adds:
 * 1. A blocking password modal for server-locked projects.
 * 2. Token generation buttons (per-author edit links + invite new author link).
 */

import { html, render } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { createContributionsView } from './view.js';

// ---------------------------------------------------------------------------
// Password Modal
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

      // Verify by attempting to load with this password
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
// Token Generation Panel
// ---------------------------------------------------------------------------

function TokenPanel({ doi, password, rows }) {
  const [linkResults, setLinkResults] = useState({});
  const [inviteLink, setInviteLink] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);

  async function hashPw(pw) {
    const encoded = new TextEncoder().encode(pw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function generateEditLink(authorName) {
    try {
      setLinkResults((prev) => ({ ...prev, [authorName]: { busy: true } }));
      let url = `${CONTRIBUTIONS_API_BASE}/contributions/token?doi=${encodeURIComponent(doi)}&type=edit_author&author=${encodeURIComponent(authorName)}`;
      if (password) url += `&password=${encodeURIComponent(await hashPw(password))}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      const token = data.token || data.key || '';
      const link = `${window.location.origin}/contributions/add?doi=${encodeURIComponent(doi)}&token=${encodeURIComponent(token)}`;
      setLinkResults((prev) => ({ ...prev, [authorName]: { link } }));
    } catch (err) {
      setLinkResults((prev) => ({ ...prev, [authorName]: { error: err.message } }));
    }
  }

  async function generateInviteLink() {
    setInviteBusy(true);
    try {
      let url = `${CONTRIBUTIONS_API_BASE}/contributions/token?doi=${encodeURIComponent(doi)}&type=add_author`;
      if (password) url += `&password=${encodeURIComponent(await hashPw(password))}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      const token = data.token || data.key || '';
      setInviteLink(`${window.location.origin}/contributions/add?doi=${encodeURIComponent(doi)}&token=${encodeURIComponent(token)}`);
    } catch (err) {
      setInviteLink(`Error: ${err.message}`);
    } finally {
      setInviteBusy(false);
    }
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
  }

  return html`
    <section class="cv-section cv-token-section">
      <h3 class="cv-section-heading">Share Links</h3>
      <p class="cv-token-desc">Generate links for authors to edit their own contributions or for new authors to add themselves.</p>

      <div class="cv-token-invite-row">
        <button class="btn-primary" onClick=${generateInviteLink} disabled=${inviteBusy}>
          ${inviteBusy ? 'Generating…' : '+ Invite New Author'}
        </button>
        ${inviteLink && !inviteLink.startsWith('Error') && html`
          <div class="cv-token-link-result">
            <input type="text" readonly value=${inviteLink} class="cv-token-link-input" />
            <button class="btn-secondary" onClick=${() => copyToClipboard(inviteLink)}>Copy</button>
          </div>
        `}
        ${inviteLink && inviteLink.startsWith('Error') && html`
          <span class="cv-token-error">${inviteLink}</span>
        `}
      </div>

      ${rows.length > 0 && html`
        <h4 class="cv-subsection-heading">Per-Author Edit Links</h4>
        <div class="cv-token-author-list">
          ${rows.map((row) => {
            const result = linkResults[row.name];
            return html`
              <div key=${row.name} class="cv-token-author-row">
                <span class="cv-token-author-name">${row.name}</span>
                <button class="btn-secondary cv-token-gen-btn"
                        disabled=${result?.busy}
                        onClick=${() => generateEditLink(row.name)}>
                  ${result?.busy ? '…' : 'Generate'}
                </button>
                ${result?.link && html`
                  <div class="cv-token-link-result">
                    <input type="text" readonly value=${result.link} class="cv-token-link-input" />
                    <button class="btn-secondary" onClick=${() => copyToClipboard(result.link)}>Copy</button>
                  </div>
                `}
                ${result?.error && html`<span class="cv-token-error">${result.error}</span>`}
              </div>
            `;
          })}
        </div>
      `}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Edit Page App
// ---------------------------------------------------------------------------

function EditApp({ doi }) {
  const [needsPassword, setNeedsPassword] = useState(null); // null = checking, true = show modal
  const [password, setPassword] = useState('');
  const [editorMounted, setEditorMounted] = useState(false);
  const editorRef = useRef(null);
  const tokenRef = useRef(null);
  const rowsRef = useRef([]);

  // Check if project is locked
  useEffect(() => {
    if (!doi) return;
    (async () => {
      try {
        const res = await fetch(
          `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(doi)}`,
        );
        if (res.status === 404) { setNeedsPassword(false); return; }
        if (!res.ok) { setNeedsPassword(false); return; }
        const data = await res.json();
        setNeedsPassword(data.locked === true);
      } catch (_) {
        setNeedsPassword(false);
      }
    })();
  }, [doi]);

  // Mount the existing editor once unlocked
  useEffect(() => {
    if (needsPassword !== false || editorMounted) return;
    if (!editorRef.current || !doi) return;
    const el = createContributionsView({ projectName: doi, password });
    editorRef.current.appendChild(el);
    setEditorMounted(true);
  }, [needsPassword, doi]);

  function handleUnlock(pw) {
    setPassword(pw);
    setNeedsPassword(false);
  }

  if (!doi) {
    return html`<div class="contributions-edit-page">
      <p class="cv-placeholder">No DOI or project name provided. <a href="/contributions">Go back</a>.</p>
    </div>`;
  }

  if (needsPassword === null) {
    return html`<div class="contributions-edit-page"><p class="cv-placeholder">Loading…</p></div>`;
  }

  if (needsPassword) {
    return html`<${PasswordModal} doi=${doi} onUnlock=${handleUnlock} />`;
  }

  return html`
    <div class="contributions-edit-page">
      <div ref=${editorRef}></div>
      <${TokenPanel} doi=${doi} password=${password} rows=${rowsRef.current} />
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
