// Map selections to ordered sessions and render the matching behavior provider.
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


export function createMultiSessionView(events, context = {}, providers = []) {
  const root = document.createElement('div');
  root.className = 'multi-session-view';
  let disposed = false;
  root._dispose = () => { disposed = true; };
  const stopped = () => disposed || context.signal?.aborted;

  const picked = pickProvider(events, providers);
  if (!picked) {
    const acquisitions = (events ?? []).filter((ev) => ev?.type === 'Acquisition').length;
    const platforms = providers.map((p) => p.label).join(', ');
    root.appendChild(placeholderEl(
      `${acquisitions} acquisition${acquisitions === 1 ? '' : 's'} selected. `
      + `Multi-session behavior currently covers ${platforms || 'no platforms'}.`,
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
    if (stopped()) return;
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
      if (stopped()) return;
      renderSections(enriched ?? sessions);
    })
    .catch((err) => {
      if (stopped()) return;
      console.warn('[MultiSession] enrich failed:', err);
      // Sections that need no enrichment still work, so render them anyway.
      renderSections(sessions);
    });

  return root;
}
