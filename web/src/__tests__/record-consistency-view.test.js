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

const CHECK_DESCRIPTION = 'Flags each record in DocDB v2 whose exact "name" key is identical to another v2 record.';
const IMPLEMENTATION_URL = 'https://github.com/AllenNeuralDynamics/biodata-cache/blob/5b10df0/'
  + 'src/biodata_cache/record_consistency.py#L39';
const MANIFEST = {
  check_count: 1,
  checked_at: '2026-09-11T18:26:32Z',
  row_count: 3,
  checks: [{
    check_key: 'docdb_duplicate_name_v2',
    description: CHECK_DESCRIPTION,
    implementation_url: IMPLEMENTATION_URL,
  }],
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
    expect(countChecks(ROWS)).toBe(1);
    expect(countChecks([...ROWS, { check_key: 'missing_s3_location' }])).toBe(2);
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

  it('renders manifest-provided check metadata beside known check keys', () => {
    const html = renderFindingRow(ROWS[0], {
      docdb_duplicate_name_v2: MANIFEST.checks[0],
    });
    expect(html).toContain('record-consistency-check-info');
    expect(html).toContain('Flags each record in DocDB v2');
    expect(html).toContain('&quot;name&quot;');
    expect(html).toContain(IMPLEMENTATION_URL);
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
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(root.querySelectorAll('.record-consistency-check-info')).toHaveLength(2);
    expect(root.querySelector('.record-consistency-check-info')?.getAttribute('href')).toBe(IMPLEMENTATION_URL);
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

  it('shows the check description on hover', async () => {
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector('.record-consistency-check-info')).not.toBeNull());

    root.querySelector('.record-consistency-check-info').dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.body.querySelector('.record-consistency-check-tooltip')?.textContent).toBe(CHECK_DESCRIPTION);
    root.querySelector('.record-consistency-check-info').dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.body.querySelector('.record-consistency-check-tooltip')).toBeNull();
  });

  it('renders findings when the optional manifest is unavailable', async () => {
    fetch.mockRejectedValue(new Error('manifest unavailable'));
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());

    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(root.querySelector('.record-consistency-check-info')).toBeNull();
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
