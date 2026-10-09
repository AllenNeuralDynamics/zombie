/**
 * df-multi-session.test.js — the dynamic-foraging multi-session provider:
 * session mapping, concatenation, layout switching, and stale-load cleanup.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  dynamicForagingProvider,
  matchForagingSession,
  joinSessionMetadata,
  concatenateSessions,
  rowSessionDate,
} from '../lib/behaviors/dynamic-foraging-multi.js';
import { createMultiSessionView, sessionsForProvider } from '../lib/behaviors/multi-session.js';
import { renderMultiEventDetail } from '../subject/details.js';

vi.mock('../dynamic_foraging/data-loader.js', () => ({ loadDfSession: vi.fn() }));
vi.mock('../dynamic_foraging/prob-plot.js', () => ({ createProbPlot: vi.fn() }));
import { loadDfSession } from '../dynamic_foraging/data-loader.js';
import { createProbPlot } from '../dynamic_foraging/prob-plot.js';

// The table is registered during bootstrap in the real app.
vi.mock('../lib/registry.js', () => ({ ensureTable: vi.fn() }));

const dfAcq = (date, time = '120000', modalities = ['behavior']) => ({
  start: new Date(`${date}T12:00:00Z`),
  end: new Date(`${date}T13:00:00Z`),
  event: 'Acquisition',
  type: 'Acquisition',
  modalities,
  data: { _assetName: `behavior_844634_${date}_${time}` },
});

const EVENTS = [dfAcq('2026-05-02'), dfAcq('2026-05-01')];
const SESSIONS = sessionsForProvider(dynamicForagingProvider, EVENTS);

describe('matchForagingSession', () => {
  it('maps a foraging acquisition to a session descriptor', () => {
    const session = matchForagingSession(dfAcq('2026-05-01'));
    expect(session).toMatchObject({
      subject_id: '844634',
      session_date: '2026-05-01',
      assetName: 'behavior_844634_2026-05-01_120000',
    });
  });

  it('rejects non-foraging events', () => {
    expect(matchForagingSession({ type: 'Surgery', event: 'Surgery', data: {} })).toBeNull();
    expect(matchForagingSession({
      type: 'Acquisition',
      event: 'ecephys_1_2026-05-03',
      data: { _assetName: 'ecephys_1_2026-05-03' },
    })).toBeNull();
  });

  it('accepts behavior sessions that also carry fiber data', () => {
    expect(matchForagingSession(dfAcq('2026-05-01', '120000', ['behavior', 'fib'])).modalities)
      .toEqual(['behavior', 'fib']);
  });
});

describe('sessionsForProvider', () => {
  it('orders sessions oldest first and dedupes', () => {
    expect(SESSIONS.map((s) => s.session_date)).toEqual(['2026-05-01', '2026-05-02']);
    expect(sessionsForProvider(dynamicForagingProvider, [dfAcq('2026-05-01'), dfAcq('2026-05-01')]))
      .toHaveLength(1);
  });
});

describe('joinSessionMetadata', () => {
  it('matches on date and nwb_suffix', () => {
    const joined = joinSessionMetadata(SESSIONS, [
      { session_date: '2026-05-01', nwb_suffix: '120000', foraging_eff: 0.5 },
      { session_date: '2026-05-02', nwb_suffix: '120000', foraging_eff: 0.7 },
    ]);
    expect(joined.map((s) => s.meta.foraging_eff)).toEqual([0.5, 0.7]);
  });

  // The cache column is not a plain string: Arrow surfaces it as a Date or a
  // day/millisecond number, which a String() compare would never match.
  it('matches rows whose session_date came back as a Date', () => {
    const joined = joinSessionMetadata(SESSIONS, [
      { session_date: new Date('2026-05-01T00:00:00Z'), nwb_suffix: '120000', foraging_eff: 0.5 },
    ]);
    expect(joined[0].meta.foraging_eff).toBe(0.5);
  });

  it('matches rows whose session_date came back as epoch days or millis', () => {
    const days = Date.UTC(2026, 4, 1) / 86400000;
    expect(joinSessionMetadata(SESSIONS, [
      { session_date: days, nwb_suffix: '120000', foraging_eff: 0.5 },
    ])[0].meta.foraging_eff).toBe(0.5);
    expect(joinSessionMetadata(SESSIONS, [
      { session_date: Date.UTC(2026, 4, 1), nwb_suffix: '120000', foraging_eff: 0.6 },
    ])[0].meta.foraging_eff).toBe(0.6);
  });

  it('prefers the session_date_iso cast when the query provides it', () => {
    expect(rowSessionDate({ session_date: 'not-a-date', session_date_iso: '2026-05-02 00:00:00' }))
      .toBe('2026-05-02');
  });

  it('falls back to the date when the suffix differs', () => {
    const joined = joinSessionMetadata(SESSIONS, [
      { session_date: '2026-05-01', nwb_suffix: 999, foraging_eff: 0.5 },
    ]);
    expect(joined[0].meta.foraging_eff).toBe(0.5);
    expect(joined[1].meta).toBeNull();
  });
});

const sessionData = () => ({
  trials: [{ goCue_t: 1, pL: 0.2, pR: 0.8, response: 0 },
    { goCue_t: 4, pL: 0.8, pR: 0.2, response: 1 }],
  rewards: { t: new Float64Array([2]), side: new Uint8Array([0]) },
  sessionEndS: 10,
});
const coordinator = { query: vi.fn(async () => ({ numRows: 0, schema: { fields: [] } })) };

beforeEach(() => {
  vi.clearAllMocks();
  loadDfSession.mockImplementation(async () => sessionData());
  createProbPlot.mockImplementation(() => ({ element: document.createElement('div'), dispose: vi.fn() }));
});

const buildView = (events = EVENTS, context = {}) => createMultiSessionView(
  events, { coordinator, ...context }, [dynamicForagingProvider],
);
const ready = (el) => vi.waitFor(() => expect(el.querySelectorAll('.df-multi-plot-card')).toHaveLength(1));

describe('concatenateSessions', () => {
  it('shifts trials and typed reward timestamps without mutating either session', async () => {
    const sources = SESSIONS.map((session) => ({ session, data: sessionData() }));
    const combined = concatenateSessions(sources);
    expect(combined.sessionEndS).toBe(20);
    expect(combined.trials.map((tr) => tr.goCue_t)).toEqual([1, 4, 11, 14]);
    expect(combined.rewards).toEqual({ t: [2, 12], side: [0, 0] });
    expect(combined.sessionStarts.map((start) => start.t)).toEqual([0, 10]);
    expect(sources[1].data.trials[0].goCue_t).toBe(1);
    const { _buildStepData, _choiceSpans } = await vi.importActual('../dynamic_foraging/prob-plot.js');
    expect(_buildStepData(combined.trials, 20).map((p) => p.t)).toEqual([1, 4, 10, 11, 14, 20]);
    expect(_choiceSpans(combined.trials, 20).choiceR).toEqual([{ x1: 4, x2: 10 }, { x1: 14, x2: 20 }]);
  });
});

it('extends each probability series to its own session end when the last trial has missing probabilities', async () => {
  const sources = SESSIONS.map((session) => ({ session, data: sessionData() }));
  sources[0].data.trials[1].pL = null;
  sources[1].data.sessionEndS = 20;
  const combined = concatenateSessions(sources);
  const { _buildStepData } = await vi.importActual('../dynamic_foraging/prob-plot.js');
  expect(_buildStepData(combined.trials, 30).map((p) => p.t)).toEqual([1, 10, 11, 14, 30]);
});

describe('multi-session behavior plots', () => {
  it('shows only a single concatenated behavior plot by default', async () => {
    const el = buildView();
    await ready(el);
    expect([...el.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Behavior']);
    expect(el.querySelector('table, img, .df-multi-fib')).toBeNull();
    expect(el.querySelector('.df-multi-plots--fixed')).toBeNull();
    expect(createProbPlot.mock.calls[0][0].sessionEndS).toBe(20);
    expect(loadDfSession.mock.calls.map(([, options]) => options.sessionDate))
      .toEqual(['2026-05-01', '2026-05-02']);
  });

  it('switches to fixed session columns and back without reloading data, disposing old plots', async () => {
    const el = buildView();
    await ready(el);
    const first = createProbPlot.mock.results[0].value;
    const toggle = el.querySelector('input[type=checkbox]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(el.querySelector('.df-multi-plots--fixed')).toBeTruthy();
    expect(el.querySelectorAll('.df-multi-plot-card')).toHaveLength(2);
    expect([...el.querySelectorAll('.df-multi-figure-caption')].map((c) => c.textContent))
      .toEqual(['2026-05-01', '2026-05-02']);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(el.querySelectorAll('.df-multi-plot-card')).toHaveLength(1);
    expect(el.querySelector('.df-multi-plots--fixed')).toBeNull();
    expect(loadDfSession).toHaveBeenCalledTimes(2);
  });

  it('applies the spout and bias setting to both layouts without reloading', async () => {
    const el = buildView();
    await ready(el);
    expect(createProbPlot.mock.calls[0][1].showSpoutBias).toBe(false);
    const [layout, details] = el.querySelectorAll('input[type=checkbox]');
    details.checked = true;
    details.dispatchEvent(new Event('change'));
    expect(createProbPlot.mock.calls.at(-1)[1]).toMatchObject({ showSpoutBias: true, spoutBiasToggle: false });
    layout.checked = true;
    layout.dispatchEvent(new Event('change'));
    expect(createProbPlot.mock.calls.slice(-2).every(([, opts]) => opts.showSpoutBias)).toBe(true);
    expect(loadDfSession).toHaveBeenCalledTimes(2);
  });

  it('offers no layout toggle for single sessions or non-behavior acquisitions', () => {
    expect(buildView([EVENTS[0]]).querySelector('input')).toBeNull();
    const nonBehavior = (date) => ({ type: 'Acquisition', data: { _assetName: `ecephys_123456_${date}_120000` } });
    expect(buildView([nonBehavior('2026-05-01'), nonBehavior('2026-05-02')]).querySelector('input')).toBeNull();
    expect(buildView([EVENTS[0], nonBehavior('2026-05-02')]).querySelector('input')).toBeNull();
  });

  it('keeps available sessions when another load fails', async () => {
    loadDfSession.mockRejectedValueOnce(new Error('unavailable'));
    const el = buildView();
    await ready(el);
    expect(el.textContent).toContain('2026-05-01: session data unavailable.');
    expect(createProbPlot.mock.calls[0][0].sessionEndS).toBe(10);
  });

  it('ignores pending results when the view is replaced', async () => {
    let resolve;
    loadDfSession.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const container = document.createElement('div');
    renderMultiEventDetail(EVENTS, container, { coordinator });
    await vi.waitFor(() => expect(resolve).toBeTruthy());
    renderMultiEventDetail([], container, { coordinator });
    resolve(sessionData());
    await new Promise((r) => setTimeout(r, 0));
    expect(createProbPlot).not.toHaveBeenCalled();
    expect(loadDfSession).toHaveBeenCalledTimes(1);
  });

  it('ignores pending results after abort', async () => {
    let resolve;
    loadDfSession.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const controller = new AbortController();
    const el = buildView(EVENTS, { signal: controller.signal });
    await vi.waitFor(() => expect(resolve).toBeTruthy());
    controller.abort();
    resolve(sessionData());
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector('.df-multi-plot-card')).toBeNull();
    expect(createProbPlot).not.toHaveBeenCalled();
  });
});
