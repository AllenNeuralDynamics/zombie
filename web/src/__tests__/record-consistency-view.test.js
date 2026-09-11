/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFlaggedRecordsQuery,
  buildManifestUrl,
  countChecks,
  createRecordConsistencyView,
  renderFindingRow,
} from '../record-consistency/view.js';

vi.mock('../lib/registry.js', () => ({
  ensureTable: vi.fn(),
  getAcorn: vi.fn(),
}));

vi.mock('../lib/arrow.js', () => ({
  queryRows: vi.fn(),
}));

import { queryRows } from '../lib/arrow.js';
import { ensureTable, getAcorn } from '../lib/registry.js';

const CHECK_DESCRIPTION = 'Fails each record in DocDB v2 whose exact "name" key is identical to another v2 record.';
const IMPLEMENTATION_URL = 'https://github.com/AllenNeuralDynamics/biodata-cache/blob/5b10df0/'
  + 'src/biodata_cache/record_consistency.py#L39';
const V1_CHECK_DESCRIPTION = 'Fails each DocDB v1 record whose exact "name" has no matches in DocDB v2.';
const V1_IMPLEMENTATION_URL = 'https://github.com/AllenNeuralDynamics/biodata-cache/blob/bde9c5e/'
  + 'src/biodata_cache/record_consistency.py#L170';
const MANIFEST = {
  check_count: 2,
  checked_at: '2026-09-11T18:26:32Z',
  row_count: 5,
  checks: [
    {
      check_key: 'docdb_duplicate_name_v2',
      description: CHECK_DESCRIPTION,
      implementation_url: IMPLEMENTATION_URL,
      processed_count: 3,
      failed_count: 2,
      unknown_count: 0,
    },
    {
      check_key: 'docdb_v1_name_missing_in_v2',
      description: V1_CHECK_DESCRIPTION,
      implementation_url: V1_IMPLEMENTATION_URL,
      processed_count: 2,
      failed_count: 1,
      unknown_count: 0,
    },
  ],
};

const ROWS = [
  {
    check_key: 'docdb_duplicate_name_v2',
    status: 'fail',
    docdb_id: 'id-001',
    docdb_version: 'v2',
    name: 'asset-one',
    location: 's3://aind-data/asset-one/',
    checked_at: '2026-09-11T18:26:32Z',
    run_id: 'run-001',
  },
  {
    check_key: 'docdb_duplicate_name_v2',
    status: 'fail',
    docdb_id: 'id-002',
    docdb_version: 'v2',
    name: 'asset-one',
    location: 's3://aind-data/asset-two/',
    checked_at: '2026-09-11T18:26:32Z',
    run_id: 'run-001',
  },
  {
    check_key: 'docdb_v1_name_missing_in_v2',
    status: 'fail',
    docdb_id: 'id-v1-001',
    docdb_version: 'v1',
    name: 'legacy-asset',
    location: 's3://aind-data/legacy-asset/',
    checked_at: '2026-09-11T18:26:32Z',
    run_id: 'run-001',
  },
];

describe('record-consistency view helpers', () => {
  it('queries non-pass findings across all checks', () => {
    const sql = buildFlaggedRecordsQuery('record_consistency_checks');
    expect(sql).toContain('FROM "record_consistency_checks"');
    expect(sql).toContain('SELECT name, check_key, status, docdb_version, docdb_id, location, run_id, checked_at');
    expect(sql).toContain("status IN ('fail', 'unknown')");
    expect(sql).toContain('ORDER BY check_key ASC, name ASC, docdb_id ASC');
  });

  it('counts represented checks', () => {
    expect(countChecks(ROWS.slice(0, 2))).toBe(1);
    expect(countChecks(ROWS)).toBe(2);
  });

  it('builds the manifest URL beside the registered table', () => {
    expect(buildManifestUrl('s3://allen-data-views/cache/record_consistency_checks.pqt')).toBe(
      'https://allen-data-views.s3.us-west-2.amazonaws.com/cache/record_consistency_checks.manifest.json',
    );
  });

  it('escapes row content and links metadata and S3 location', () => {
    const html = renderFindingRow({
      ...ROWS[0],
      name: '"><img src=x>',
      docdb_id: 'id"><script>',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('docdb_duplicate_name_v2');
    expect(html).toContain('run-001');
    expect(html).toContain('/record?name=');
    expect(html).toContain('s3.console.aws.amazon.com');
  });

  it('renders a plain check key in each finding row', () => {
    const html = renderFindingRow(ROWS[0]);
    expect(html).toContain('<code>docdb_duplicate_name_v2</code>');
    expect(html).not.toContain(IMPLEMENTATION_URL);
  });
});

describe('createRecordConsistencyView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureTable.mockResolvedValue('record_consistency_checks');
    getAcorn.mockReturnValue({
      location: 's3://allen-data-views/cache/record_consistency_checks.pqt',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(MANIFEST),
    }));
    queryRows.mockResolvedValue(ROWS);
  });

  it('loads the table and renders flagged records', async () => {
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());

    expect(ensureTable).toHaveBeenCalledWith(expect.anything(), 'record_consistency_checks');
    expect(queryRows).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("status IN ('fail', 'unknown')"));
    expect(root.querySelector('.record-consistency-summary-panel')?.textContent).toContain('Flagged results');
    expect(root.querySelector('.record-consistency-summary-panel')?.textContent).toContain('Evaluated rows');
    const checkCards = root.querySelectorAll('.record-consistency-check-card');
    expect(checkCards).toHaveLength(2);
    expect(checkCards[0].textContent).toContain(CHECK_DESCRIPTION);
    expect(checkCards[0].textContent).toContain('2 flagged');
    expect(checkCards[0].textContent).toContain('3 evaluated');
    expect(checkCards[1].textContent).toContain(V1_CHECK_DESCRIPTION);
    expect(checkCards[1].textContent).toContain('1 flagged');
    expect(checkCards[1].textContent).toContain('2 evaluated');
    expect(checkCards[1].textContent).toContain('Implementation permalink');
    expect(checkCards[0].querySelector('.record-consistency-implementation a')?.getAttribute('href'))
      .toBe(IMPLEMENTATION_URL);
    expect(checkCards[1].querySelector('.record-consistency-implementation a')?.getAttribute('href'))
      .toBe(V1_IMPLEMENTATION_URL);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(3);
    expect([...root.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual([
      'Name',
      'Check',
      'Status',
      'DocDB version',
      'DocDB ID',
      's3_location',
      'Run ID',
      'Checked at',
    ]);
  });

  it('renders findings when the optional manifest is unavailable', async () => {
    fetch.mockRejectedValue(new Error('manifest unavailable'));
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());

    expect(root.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(root.querySelectorAll('.record-consistency-check-card')).toHaveLength(2);
    expect(root.querySelector('.record-consistency-check-card')?.textContent).toContain('Description unavailable.');
  });

  it('renders an explicit empty state', async () => {
    queryRows.mockResolvedValue([]);
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain('No flagged records.'));
    expect(root.querySelector('table')).toBeNull();
  });

  it('renders a useful load error', async () => {
    ensureTable.mockRejectedValue(new Error('missing registry entry'));
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain('Failed to load record-consistency checks'));
    expect(root.querySelector('.loading-message.error')).not.toBeNull();
  });
});
