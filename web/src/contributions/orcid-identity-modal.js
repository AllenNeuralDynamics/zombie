import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { readOrcidProfile, searchOrcidProfiles } from './orcid-identity.js';

function authorAffiliations(contributor) {
  const affiliation = contributor?.author?.affiliation;
  if (Array.isArray(affiliation)) return affiliation.filter(Boolean).join(', ');
  return typeof affiliation === 'string' ? affiliation : '';
}

export function OrcidIdentityModal({
  mode = 'search',
  name = '',
  orcid = '',
  user = null,
  candidates = [],
  onResolve = () => {},
  onLink = () => {},
  onCancel = () => {},
}) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(onCancel);
  const [profiles, setProfiles] = useState([]);
  const [searching, setSearching] = useState(mode !== 'link');
  const [searchError, setSearchError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  cancelRef.current = onCancel;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!busyRef.current) cancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable[focusable.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) {
        event.preventDefault();
        focusable[0].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (mode === 'link') return undefined;
    const controller = new AbortController();
    setSearching(true);
    setSearchError('');
    setActionError('');
    setProfiles([]);
    const lookup = mode === 'resolve'
      ? readOrcidProfile(orcid, controller.signal).then((profile) => [profile])
      : searchOrcidProfiles(name, controller.signal);
    lookup.then(setProfiles)
      .catch((error) => {
        if (!controller.signal.aborted) setSearchError(error.message || 'ORCID search failed.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    return () => controller.abort();
  }, [mode, name, orcid]);

  async function resolveProfile(profile) {
    setBusy(true);
    setActionError('');
    try {
      await onResolve({ ...profile, name: profile.name || String(name).trim() });
      onCancel();
    } catch (error) {
      setActionError(error.message || 'Unable to use this ORCID.');
    } finally {
      setBusy(false);
    }
  }

  async function linkContributor(candidate) {
    setBusy(true);
    setActionError('');
    try {
      await onLink(candidate);
      onCancel();
    } catch (error) {
      setActionError(error.message || 'Unable to link this contributor.');
    } finally {
      setBusy(false);
    }
  }

  const isSearch = mode === 'search';
  const isResolve = mode === 'resolve';
  const titleId = 'cv-orcid-identity-title';
  return html`
    <div class="cv-modal-backdrop" onClick=${(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section class="cv-modal cv-orcid-modal" role="dialog" aria-modal="true"
               aria-labelledby=${titleId} tabindex="-1" ref=${dialogRef}>
        <header class="cv-orcid-modal-header">
          <h2 id=${titleId} class="cv-modal-title">
            ${isSearch ? 'Match this name to ORCID'
              : isResolve ? 'Confirm ORCID identity' : 'Is this your contributor record?'}
          </h2>
          <button type="button" class="cv-orcid-modal-close" aria-label="Close"
                  disabled=${busy} onClick=${onCancel}>×</button>
        </header>

        ${(isSearch || isResolve) ? html`
          <p class="cv-modal-desc">
            ${isSearch ? 'Entered name:' : 'ORCID iD entered:'}${' '}
            <strong>${isSearch ? name : orcid}</strong>
          </p>
          ${searching && html`<p class="cv-orcid-modal-status" role="status">
            ${isSearch ? 'Searching ORCID…' : 'Looking up ORCID…'}
          </p>`}
          ${searchError && html`<p class="cv-modal-error" role="alert">${searchError}</p>`}
          ${!searching && !searchError && profiles.length === 0 && html`
            <p class="cv-orcid-modal-status">No ORCID matches found.</p>
          `}
          <div class="cv-orcid-match-list">
            ${profiles.map((profile) => html`
              <article key=${profile.orcid} class="cv-orcid-match-card">
                <div>
                  <strong class="cv-orcid-match-name">
                    ${profile.name || 'Name is not publicly available'}
                  </strong>
                  <div class="cv-orcid-match-id">${profile.orcid}</div>
                </div>
                <div class="cv-orcid-match-actions">
                  <button type="button" class="btn-primary"
                          disabled=${busy} onClick=${() => resolveProfile(profile)}>
                    ${profile.name ? 'Use ORCID name' : 'Use this ORCID'}
                  </button>
                  <a href=${`https://orcid.org/${profile.orcid}`} target="_blank"
                     rel="noopener noreferrer">View profile</a>
                </div>
              </article>
            `)}
          </div>
          ${profiles.some((profile) => !profile.name) && html`
            <p class="cv-orcid-modal-status">
              ${isSearch ? 'ORCID hides this name, so the entered name will be kept.'
                : 'ORCID hides this name, so the current name will be kept.'}
            </p>
          `}
        ` : html`
          <p class="cv-modal-desc">
            Signed in as <strong>${user?.name || user?.orcid}</strong>
            ${user?.orcid && html`<span class="cv-orcid-match-id">${user.orcid}</span>`}
          </p>
          <div class="cv-orcid-match-list">
            ${candidates.map(({ contributor, name: candidateName, score }) => html`
              <article key=${candidateName} class="cv-orcid-match-card">
                <div>
                  <strong class="cv-orcid-match-name">${candidateName}</strong>
                  ${authorAffiliations(contributor) && html`
                    <div class="cv-orcid-match-context">${authorAffiliations(contributor)}</div>
                  `}
                  ${score === 1 && html`<div class="cv-orcid-match-context">Name match</div>`}
                </div>
                <button type="button" class="btn-primary" disabled=${busy}
                        onClick=${() => linkContributor({ contributor, name: candidateName })}>
                  ${busy ? 'Linking…' : 'Link this record'}
                </button>
              </article>
            `)}
          </div>
          <button type="button" class="btn-secondary cv-orcid-continue"
                  disabled=${busy} onClick=${onCancel}>Continue as a new contributor</button>
        `}
        ${actionError && html`<p class="cv-modal-error" role="alert">${actionError}</p>`}
        ${(isSearch || isResolve) && html`
          <button type="button" class="btn-secondary cv-orcid-continue"
                  disabled=${busy} onClick=${onCancel}>Cancel</button>
        `}
      </section>
    </div>
  `;
}
