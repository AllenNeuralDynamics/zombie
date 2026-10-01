/**
 * multi-session-harness.test.js — the platform-agnostic multi-session harness,
 * exercised with fake providers so it stays honest about the contract other
 * platforms will implement against.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createMultiSessionView,
  pickProvider,
  sessionsForProvider,
} from '../lib/behaviors/multi-session.js';

const ev = (platform, date) => ({ type: 'Acquisition', platform, date });

/** Minimal provider: matches events of one platform, one section. */
function fakeProvider(key, { sections, enrich } = {}) {
  return {
    key,
    label: key,
    matchSession: (event) => (event?.platform === key
      ? { session_date: event.date, nwb_suffix: '' }
      : null),
    ...(enrich ? { enrich } : {}),
    sections: sections ?? [{
      key: 'only',
      title: 'Only',
      build: (sessions) => {
        const el = document.createElement('div');
        el.className = 'fake-section';
        el.textContent = sessions.map((s) => s.session_date).join(',');
        return el;
      },
    }],
  };
}

const A_EVENTS = [ev('a', '2026-05-02'), ev('a', '2026-05-01')];

describe('sessionsForProvider', () => {
  it('sorts oldest first and drops unmatched events', () => {
    const sessions = sessionsForProvider(fakeProvider('a'), [...A_EVENTS, ev('b', '2026-05-03')]);
    expect(sessions.map((s) => s.session_date)).toEqual(['2026-05-01', '2026-05-02']);
  });

  it('dedupes by date + suffix', () => {
    expect(sessionsForProvider(fakeProvider('a'), [ev('a', '2026-05-01'), ev('a', '2026-05-01')]))
      .toHaveLength(1);
  });

  it('honours a provider-supplied sessionKey', () => {
    const provider = {
      ...fakeProvider('a'),
      sessionKey: () => 'same-for-everything',
    };
    expect(sessionsForProvider(provider, A_EVENTS)).toHaveLength(1);
  });
});

describe('pickProvider', () => {
  const providers = [fakeProvider('a'), fakeProvider('b')];

  it('picks the provider covering the most of the selection', () => {
    const events = [ev('a', '2026-05-01'), ev('b', '2026-05-02'), ev('b', '2026-05-03')];
    expect(pickProvider(events, providers).provider.key).toBe('b');
  });

  it('needs at least two sessions — one is the single-event panel\'s job', () => {
    expect(pickProvider([ev('a', '2026-05-01')], providers)).toBeNull();
  });
});

describe('createMultiSessionView', () => {
  it('renders the header and the provider sections', () => {
    const el = createMultiSessionView(A_EVENTS, {}, [fakeProvider('a')]);
    expect(el.dataset.platform).toBe('a');
    expect(el.querySelector('.multi-session-header').textContent)
      .toBe('2 a sessions · 2026-05-01 → 2026-05-02');
    expect(el.querySelector('.fake-section').textContent).toBe('2026-05-01,2026-05-02');
  });

  it('lists the covered platforms when nothing matches', () => {
    const el = createMultiSessionView([ev('z', '2026-05-01')], {}, [fakeProvider('a'), fakeProvider('b')]);
    expect(el.dataset.platform).toBeUndefined();
    expect(el.textContent).toContain('currently covers a, b');
  });

  it('omits sections whose build returns null', () => {
    const provider = fakeProvider('a', {
      sections: [
        { key: 'kept', title: 'Kept', build: () => document.createElement('div') },
        { key: 'dropped', title: 'Dropped', build: () => null },
      ],
    });
    const titles = [...createMultiSessionView(A_EVENTS, {}, [provider])
      .querySelectorAll('.multi-session-section > h4')].map((h) => h.textContent);
    expect(titles).toEqual(['Kept']);
  });

  it('contains a section that throws instead of losing the whole view', () => {
    const provider = fakeProvider('a', {
      sections: [
        { key: 'boom', title: 'Boom', build: () => { throw new Error('nope'); } },
        { key: 'fine', title: 'Fine', build: () => document.createElement('div') },
      ],
    });
    const el = createMultiSessionView(A_EVENTS, {}, [provider]);
    expect(el.textContent).toContain('Failed to build boom.');
    expect(el.querySelectorAll('.multi-session-section')).toHaveLength(2);
  });

  it('runs enrich once and hands its result to every section', async () => {
    const enrich = vi.fn(async (sessions) => sessions.map((s) => ({ ...s, session_date: `${s.session_date}!` })));
    const provider = fakeProvider('a', { enrich });
    const el = createMultiSessionView(A_EVENTS, {}, [provider]);
    expect(el.querySelector('.subject-loading')).toBeTruthy();
    await vi.waitFor(() => {
      expect(el.querySelector('.fake-section')?.textContent).toBe('2026-05-01!,2026-05-02!');
    });
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  it('renders the un-enriched sessions when enrich fails', async () => {
    const provider = fakeProvider('a', { enrich: async () => { throw new Error('nope'); } });
    const el = createMultiSessionView(A_EVENTS, {}, [provider]);
    await vi.waitFor(() => {
      expect(el.querySelector('.fake-section')?.textContent).toBe('2026-05-01,2026-05-02');
    });
  });

  it('renders nothing further once the signal is aborted', async () => {
    const controller = new AbortController();
    const provider = fakeProvider('a', { enrich: async (s) => s });
    const el = createMultiSessionView(A_EVENTS, { signal: controller.signal }, [provider]);
    controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.fake-section')).toBeNull();
  });
});
