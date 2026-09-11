/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFlaggedRecordsQuery,
  countChecks,
  createRecordConsistencyView,
  renderFindingRow,
} from '../record-consistency/view.js';

vi.mock('../lib/registry.js', () => ({
  ensureTable: vi.fn(),
}));

vi.mock('../lib/arrow.js', () => ({
  queryRows: vi.fn(),
}));

import { queryRows } from '../lib/arrow.js';
import { ensureTable } from '../lib/registry.js';

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
});

describe('createRecordConsistencyView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureTable.mockResolvedValue('record_consistency_checks');
    queryRows.mockResolvedValue(ROWS);
  });

  it('loads the table and renders flagged records', async () => {
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.querySelector('tbody tr')).not.toBeNull());

    expect(ensureTable).toHaveBeenCalledWith(expect.anything(), 'record_consistency_checks');
    expect(queryRows).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("status IN ('fail', 'unknown')"));
    expect(root.textContent).toContain('2 flagged record(s) across 1 check(s).');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
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
