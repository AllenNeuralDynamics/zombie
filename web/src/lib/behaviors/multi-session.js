/**
 * multi-session.js — platform-agnostic harness for multi-session views.
 *
 * When the subject timeline reports a multi-selection, the per-session detail
 * panel is replaced by one of these. Everything platform-specific lives in a
 * *provider*; this module owns only the parts every platform shares:
 *
 *   - mapping selected timeline events to sessions (dedupe + chronological),
 *   - picking the provider that covers the selection,
 *   - the header line and the titled section scaffolding,
 *   - one shared async enrichment pass, with abort and error handling,
 *   - the placeholder shown when no provider covers the selection.
 *
 * A provider is a plain object:
 *
 *   {
 *     key: 'dynamic_foraging',
 *     label: 'dynamic foraging',          // used in the header line
 *     matchSession(event) -> session|null, // one selected event → a session
 *     sessionKey(session) -> string,       // dedupe key (default: date|suffix)
 *     async enrich(sessions, ctx) -> sessions,  // optional shared load
 *     sections: [{ key, title, build(sessions, ctx) -> Element|null }],
 *   }
 *
 * `build` may return null to omit its section (e.g. no fiber data for these
 * sessions), and may kick off its own async work — the harness only guarantees
 * that `enrich` has already run.
 *
 * To support a new platform: write a provider and add it to `PROVIDERS` in
 * multi-session-providers.js. Nothing in this file should learn about it.
 */

/**
 * Map selected events to this provider's sessions, deduplicated and ordered
 * oldest → newest.
 *
 * @param {object} provider
 * @param {object[]} events - Selected subject-timeline events.
 * @returns {object[]}
 */
export function sessionsForProvider(provider, events) {
  const keyOf = provider.sessionKey
    ?? ((s) => `${s.session_date ?? ''}|${s.nwb_suffix ?? ''}`);
  const sessions = [];
  const seen = new Set();
  for (const event of events ?? []) {
    const session = provider.matchSession(event);
    if (!session) continue;
    const key = keyOf(session);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  return sessions.sort((a, b) => String(a.session_date ?? '').localeCompare(String(b.session_date ?? '')));
}

/**
 * Pick the provider covering the most of this selection, requiring at least
 * two sessions — one session is what the per-event detail panel is for.
 *
 * @param {object[]} events
 * @param {object[]} providers
 * @returns {{provider: object, sessions: object[]}|null}
 */
export function pickProvider(events, providers) {
  let best = null;
  for (const provider of providers ?? []) {
    const sessions = sessionsForProvider(provider, events);
    if (sessions.length < 2) continue;
    if (!best || sessions.length > best.sessions.length) best = { provider, sessions };
  }
  return best;
}

function buildHeader(provider, sessions) {
  const el = document.createElement('div');
  el.className = 'multi-session-header';
  const first = sessions[0]?.session_date;
  const last = sessions[sessions.length - 1]?.session_date;
  const span = first && last && first !== last ? ` · ${first} → ${last}` : '';
  el.textContent = `${sessions.length} ${provider.label} session${sessions.length === 1 ? '' : 's'}${span}`;
  return el;
}

function buildSection(title, body) {
  const section = document.createElement('div');
  section.className = 'multi-session-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.append(heading, body);
  return section;
}

function placeholderEl(text) {
  const el = document.createElement('p');
  el.className = 'detail-placeholder';
  el.textContent = text;
  return el;
}

/**
 * Build the multi-session view for a selection, or a placeholder explaining
 * why there isn't one.
 *
 * @param {object[]} events - Selected timeline events.
 * @param {object} [context] - { coordinator, subjectId, signal, … } passed to the provider.
 * @param {object[]} providers - Provider list (injected so tests can supply fakes).
 * @returns {HTMLElement}
 */
export function createMultiSessionView(events, context = {}, providers = []) {
  const root = document.createElement('div');
  root.className = 'multi-session-view';

  const picked = pickProvider(events, providers);
  if (!picked) {
    const acquisitions = (events ?? []).filter((ev) => ev?.type === 'Acquisition').length;
    const platforms = providers.map((p) => p.label).join(', ');
    root.appendChild(placeholderEl(
      `${acquisitions} acquisition${acquisitions === 1 ? '' : 's'} selected. `
      + `Cross-session comparison currently covers ${platforms || 'no platforms'}.`,
    ));
    return root;
  }

  const { provider, sessions } = picked;
  root.dataset.platform = provider.key;
  root.appendChild(buildHeader(provider, sessions));

  const body = document.createElement('div');
  body.className = 'multi-session-body';
  root.appendChild(body);

  const renderSections = (enriched) => {
    body.replaceChildren();
    for (const section of provider.sections ?? []) {
      let el = null;
      try {
        el = section.build(enriched, context);
      } catch (err) {
        console.error(`[MultiSession] section "${section.key}" failed:`, err);
        el = placeholderEl(`Failed to build ${section.title.toLowerCase()}.`);
      }
      if (el) body.appendChild(buildSection(section.title, el));
    }
  };

  if (typeof provider.enrich !== 'function') {
    renderSections(sessions);
    return root;
  }

  const loading = document.createElement('p');
  loading.className = 'subject-loading';
  loading.textContent = 'Loading session data…';
  body.appendChild(loading);

  Promise.resolve(provider.enrich(sessions, context))
    .then((enriched) => {
      if (context.signal?.aborted) return;
      renderSections(enriched ?? sessions);
    })
    .catch((err) => {
      if (context.signal?.aborted) return;
      console.warn('[MultiSession] enrich failed:', err);
      // Sections that need no enrichment still work, so render them anyway.
      renderSections(sessions);
    });

  return root;
}
