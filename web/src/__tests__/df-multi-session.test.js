/**
 * df-multi-session.test.js — the dynamic-foraging multi-session provider:
 * event → session mapping, metadata join, metric series, session colours, and
 * the rendered sections with a mocked coordinator.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dynamicForagingProvider,
  matchForagingSession,
  joinSessionMetadata,
  buildMetricSeries,
  sessionColors,
  rowSessionDate,
} from '../lib/behaviors/dynamic-foraging-multi.js';
import { createMultiSessionView, sessionsForProvider } from '../lib/behaviors/multi-session.js';
import { renderMultiEventDetail } from '../subject/details.js';

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

  it('carries modalities through, so the fiber section can gate on them', () => {
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

describe('buildMetricSeries', () => {
  const joined = [
    { session_date: '2026-05-01', meta: { foraging_eff: 0.4 } },
    { session_date: '2026-05-02', meta: { foraging_eff: null } },
    { session_date: '2026-05-03', meta: null },
    { session_date: '2026-05-04', meta: { foraging_eff: 0.8 } },
  ];

  it('keeps only sessions with a finite value', () => {
    const series = buildMetricSeries(joined, 'foraging_eff');
    expect(series.map((d) => d.value)).toEqual([0.4, 0.8]);
    expect(series[0].date.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('returns an empty series for an unknown metric', () => {
    expect(buildMetricSeries(joined, 'nope')).toEqual([]);
  });
});

describe('sessionColors', () => {
  it('walks a single-hue ramp, one step per session', () => {
    const colors = sessionColors(3, ['#000000', '#ffffff']);
    expect(colors).toEqual(['#000000', '#808080', '#ffffff']);
  });

  it('never cycles: n sessions give n distinct steps', () => {
    const colors = sessionColors(12, ['#3aa76d', '#08331d']);
    expect(new Set(colors).size).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function mockCoordinator(rows) {
  return {
    query: vi.fn(async () => ({
      numRows: rows.length,
      schema: { fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })) },
      getChild: (name) => ({ get: (i) => rows[i][name] }),
    })),
  };
}

const ROWS = [
  {
    subject_id: '844634', session_date: '2026-05-01', nwb_suffix: '120000',
    current_stage_actual: 'STAGE_2', task: 'Coupled Baiting',
    foraging_eff: 0.41, finished_trials: 300, finished_rate: 0.9, bias_naive: 0.1,
  },
  {
    subject_id: '844634', session_date: '2026-05-02', nwb_suffix: '120000',
    current_stage_actual: 'STAGE_3', task: 'Coupled Baiting',
    foraging_eff: 0.62, finished_trials: 420, finished_rate: 0.95, bias_naive: -0.05,
  },
];

const providers = [dynamicForagingProvider];

describe('createMultiSessionView — dynamic foraging', () => {
  it('names the platform and the date span', async () => {
    const el = createMultiSessionView(EVENTS, { coordinator: null }, providers);
    expect(el.dataset.platform).toBe('dynamic_foraging');
    expect(el.querySelector('.multi-session-header').textContent)
      .toBe('2 dynamic foraging sessions · 2026-05-01 → 2026-05-02');
  });

  it('renders metrics, session figures and the collapsed pre-rendered block', async () => {
    const coordinator = mockCoordinator(ROWS);
    const el = createMultiSessionView(EVENTS, { coordinator, subjectId: '844634' }, providers);
    await vi.waitFor(() => {
      expect(el.querySelector('.df-multi-table')).toBeTruthy();
    });

    const titles = [...el.querySelectorAll('.multi-session-section > h4')].map((h) => h.textContent);
    expect(titles).toEqual(['Across sessions', 'Session figures', 'Choice history']);

    // One trend chart per metric that has at least two points.
    expect(el.querySelectorAll('.df-multi-trend-cell')).toHaveLength(4);
    const bodyText = el.querySelector('.df-multi-table tbody').textContent;
    expect(bodyText).toContain('STAGE_2');
    expect(bodyText).toContain('0.620');

    // One boxed column per session, captioned with the stage from the cache,
    // and only the leftmost carrying the shared row-label gutter.
    const columns = el.querySelectorAll('.df-multi-plot-card');
    expect(columns).toHaveLength(2);
    expect([...columns].map((c) => c.classList.contains('df-multi-plot-card--labelled')))
      .toEqual([true, false]);
    expect(el.querySelector('.df-multi-figure-caption').textContent).toBe('2026-05-01 · STAGE_2');
  });

  it('defers the pre-rendered images until the block is opened', async () => {
    const coordinator = mockCoordinator(ROWS);
    const el = createMultiSessionView(EVENTS, { coordinator, subjectId: '844634' }, providers);
    await vi.waitFor(() => expect(el.querySelector('.df-multi-choice-history')).toBeTruthy());

    const details = el.querySelector('.df-multi-choice-history');
    expect(details.querySelectorAll('img')).toHaveLength(0);
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    const imgs = details.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].src).toContain('844634_2026-05-01_120000_choice_history.png');
  });

  it('omits the fiber section unless the sessions carry fib data', async () => {
    const coordinator = mockCoordinator(ROWS);
    const el = createMultiSessionView(EVENTS, { coordinator, subjectId: '844634' }, providers);
    await vi.waitFor(() => expect(el.querySelector('.df-multi-table')).toBeTruthy());
    expect(el.querySelector('.df-multi-fib')).toBeNull();

    const fibEvents = [
      dfAcq('2026-05-01', '120000', ['behavior', 'fib']),
      dfAcq('2026-05-02', '120000', ['behavior', 'fib']),
    ];
    const fibEl = createMultiSessionView(fibEvents, { coordinator, subjectId: '844634' }, providers);
    await vi.waitFor(() => expect(fibEl.querySelector('.df-multi-fib')).toBeTruthy());

    // Implant beside the session strip, plus the layout switch.
    expect(fibEl.querySelector('.df-multi-fib-implant')).toBeTruthy();
    expect(fibEl.querySelector('.df-multi-fib-strip')).toBeTruthy();
    const layouts = [...fibEl.querySelectorAll('.df-multi-fib-controls option')]
      .map((o) => o.value);
    expect(layouts).toContain('aggregate');
    expect(layouts).toContain('columns');
    expect(layouts).toContain('overlay');
    // Aggregate is the default: per-session panels stop scaling past a few.
    expect(fibEl.querySelector('.df-multi-fib-controls select:nth-of-type(1)')).toBeTruthy();
    const layoutSel = [...fibEl.querySelectorAll('.df-multi-fib-controls select')]
      .find((sel) => [...sel.options].some((o) => o.value === 'aggregate'));
    expect(layoutSel.value).toBe('aggregate');
  });

  it('queries the selected dates once', async () => {
    const coordinator = mockCoordinator(ROWS);
    createMultiSessionView(EVENTS, { coordinator, subjectId: '844634' }, providers);
    await vi.waitFor(() => {
      const sql = coordinator.query.mock.calls.map(([q]) => q).join('\n');
      expect(sql).toContain("session_date IN ('2026-05-01', '2026-05-02')");
    });
  });

  it('still renders sections when the metric query fails', async () => {
    const coordinator = { query: vi.fn(async () => { throw new Error('boom'); }) };
    const el = createMultiSessionView(EVENTS, { coordinator }, providers);
    await vi.waitFor(() => {
      expect(el.textContent).toContain('No foraging cache rows found');
    });
    expect(el.querySelectorAll('.df-multi-plot-card')).toHaveLength(2);
  });
});

describe('renderMultiEventDetail', () => {
  it('renders the multi-session view for two or more foraging sessions', () => {
    const container = document.createElement('div');
    renderMultiEventDetail(EVENTS, container, {});
    expect(container.querySelector('.multi-session-view')).toBeTruthy();
    expect(container.querySelector('[data-platform="dynamic_foraging"]')).toBeTruthy();
  });

  it('explains itself when no provider covers the selection', () => {
    const container = document.createElement('div');
    renderMultiEventDetail(
      [
        { type: 'Acquisition', event: 'ecephys_1_2026-05-01', start: new Date('2026-05-01'), data: { _assetName: 'ecephys_1_2026-05-01' } },
        { type: 'Acquisition', event: 'ecephys_1_2026-05-02', start: new Date('2026-05-02'), data: { _assetName: 'ecephys_1_2026-05-02' } },
      ],
      container,
      {},
    );
    expect(container.querySelector('[data-platform]')).toBeNull();
    expect(container.textContent).toContain('2 acquisitions selected');
    expect(container.textContent).toContain('dynamic foraging');
  });

  it('disposes the previous view before rendering a new one', () => {
    const container = document.createElement('div');
    renderMultiEventDetail(EVENTS, container, {});
    const dispose = vi.fn();
    container.querySelector('.multi-session-view')._dispose = dispose;
    renderMultiEventDetail(EVENTS, container, {});
    expect(dispose).toHaveBeenCalled();
  });
});
