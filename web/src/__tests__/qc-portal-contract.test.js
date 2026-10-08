// @vitest-environment happy-dom
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../lib/qc-spa-auth.js', () => ({ getQcIdentityToken: vi.fn(async () => 'good-token') }));
import { getQcIdentityToken } from '../lib/qc-spa-auth.js';
import { buildQcSubmitPayload } from '../qc/editor.js';
import { submitQcEdit } from '../qc/api.js';
import { hashQc } from '../qc/canonical.js';
import { buildSpimQcMetrics } from '../qc/spim-metrics.js';
import { buildFiberCcfMetrics } from '../qc/fiber-ccf.js';
import { renderMedia } from '../qc/media.js';
import { getQcUser, loginToQcPortal, logoutQcPortal } from '../lib/qc-auth.js';
import {
  listProposals, getProposal, createProposal, approveProposal, rejectProposal, withdrawProposal,
} from '../migrate/lib.js';

const fixturePath = resolve('src/__tests__/fixtures/qc-portal-contract.json');
const metric = (name, value, extra = {}) => ({
  object_type: 'QC metric', name, value,
  modality: { name: 'Extracellular electrophysiology', abbreviation: 'ecephys' },
  stage: 'Processing', tags: {},
  status_history: [{ object_type: 'QC status', status: 'Pending', evaluator: 'system', timestamp: '2024-01-01T00:00:00Z' }],
  ...extra,
});
const record = metrics => ({
  _id: 'record-1', name: 'asset-1',
  quality_control: {
    object_type: 'Quality control', schema_version: '2.4.0', metrics,
    notes: 'original notes', default_grouping: ['type'], allow_tag_failures: ['existing allowance'],
  },
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it('freezes requests from the real QC portal clients for server replay', async () => {
  const requests = [];
  let currentName;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({
      name: currentName, path: parsed.pathname + parsed.search, method: options.method ?? 'GET',
      headers: options.headers ?? {}, ...(options.credentials ? { credentials: options.credentials } : {}),
      ...(options.body !== undefined ? { body: JSON.parse(options.body) } : {}),
    });
    const body = { status: 'applied', proposal: { proposal_id: 'p1' }, proposals: [], authenticated: true, user: 'alice', url: 'https://example.org/signed.png' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  const qc = [];
  async function submit(name, liveRecord, options) {
    currentName = name;
    const payload = buildQcSubmitPayload(liveRecord, {
      ...options, expectedQcHash: await hashQc(liveRecord.quality_control),
    });
    qc.push({ name, record: liveRecord });
    await submitQcEdit(payload);
  }
  await submit('qc-value-status', record([metric('drift', 0.5)]), {
    pendingChanges: { drift: { value: 0.94, status: 'Pass' } },
  });
  for (const value of [null, ['good'], { type: 'dropdown', options: ['Good', 'Bad'], status: ['Pass', 'Fail'], value: 'Good' }, { AP: 10, ML: 20, DV: null }]) {
    await submit(`qc-value-${qc.length}`, record([metric('quality', null)]), { pendingChanges: { quality: { value } } });
  }
  await submit('qc-notes', record([metric('drift', 0.5)]), { notesChanged: true, notes: '' });
  await submit('qc-curation', record([metric('Sorting Curation', ['old', 'keep'], {
    object_type: 'Curation metric', type: 'manual',
    curation_history: [0, 1].map(() => ({ object_type: 'Curation history', curator: 'system', timestamp: '2024-01-01T00:00:00Z' })),
  })]), { pendingChanges: { 'Sorting Curation': { delete_curation_indices: [0], value: { unit_ids: [1, 2], labels: { quality: ['good'] } }, status: 'Pass' } } });
  const spimRecord = {
    ...record([]), data_description: { data_level: 'derived' }, instrument: { instrument_id: 'SmartSPIM' },
    acquisition: { channels: [{ channel_name: 'Ex_488_Em_525' }, { channel_name: 'Ex_561_Em_600' }] },
  };
  await submit('qc-smartspim', spimRecord, { addedMetrics: buildSpimQcMetrics(spimRecord) });
  await submit('qc-fiber', record([]), { addedMetrics: buildFiberCcfMetrics([{ name: 'Fiber 0' }], 'https://example.org/neuroglancer') });

  const proposed = { _id: 'abc', name: 'asset-1', subject: { subject_id: '2' } };
  const calls = [
    ['list-default', () => listProposals()],
    ['list-filtered', () => listProposals({ status: 'open,rejected', version: 'v2', id: 'abc' })],
    ['proposal-detail', () => getProposal('p1')],
    ['proposal-create', () => createProposal({ version: 'v2', id: 'abc', body: proposed })],
    ['proposal-rebase', () => createProposal({ version: 'v1', id: 'abc', body: proposed, note: 'Rebased', supersedes: 'p1' })],
    ['proposal-approve', () => approveProposal('p1', 'reviewed-hash')],
    ['proposal-reject', () => rejectProposal('p1', 'Needs correction')],
    ['proposal-withdraw', () => withdrawProposal('p1')],
    ['session-me', () => getQcUser()],
    ['session-logout', () => logoutQcPortal()],
  ];
  for (const [name, call] of calls) { currentName = name; await call(); }
  currentName = 'media-sign';
  const media = renderMedia('figures/QC image.png', 'private-bucket', 'prefix', 'asset with spaces');
  await vi.waitFor(() => expect(media.querySelector('img').src).toBe('https://example.org/signed.png'));
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { assign } });
  loginToQcPortal('https://data.allenneuraldynamics.org/migrate/submit?id=abc&version=v2');
  const loginUrl = new URL(assign.mock.calls[0][0]);
  requests.push({ name: 'session-login', path: loginUrl.pathname + loginUrl.search, method: 'GET', headers: {} });
  const contract = { qc, requests };
  if (process.env.UPDATE_QC_PORTAL_CONTRACT === '1') writeFileSync(fixturePath, JSON.stringify(contract, null, 2) + '\n');
  expect(contract).toEqual(JSON.parse(readFileSync(fixturePath, 'utf8')));
});

it('retries QC submission once with the same reviewed payload after token renewal', async () => {
  getQcIdentityToken.mockResolvedValueOnce('expired-token').mockResolvedValueOnce('renewed-token');
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'unauthenticated' }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'applied' }) });
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const payload = fixture.requests.find(request => request.name === 'qc-smartspim').body;
  expect(await submitQcEdit(payload, { fetchImpl })).toEqual({ status: 'applied' });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls.map(([, options]) => options.headers.Authorization))
    .toEqual(['Bearer expired-token', 'Bearer renewed-token']);
  for (const [, options] of fetchImpl.mock.calls) expect(JSON.parse(options.body)).toEqual(payload);
  expect(getQcIdentityToken).toHaveBeenLastCalledWith({ forceRefresh: true });
});

it.each([[409, 'stale_record'], [422, 'invalid_qc_data'], [400, 'unsupported_request_field'], [502, 'docdb_unavailable']])(
  'preserves QC server error %s/%s without resubmitting', async (status, error) => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status, json: async () => ({ status: 'error', error }) }));
    await expect(submitQcEdit({}, { fetchImpl })).rejects.toMatchObject({ status, code: error });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);
