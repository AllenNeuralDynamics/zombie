/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDuplicateGroupDetails,
  buildDuplicateNameQuery,
  countDuplicateNameGroups,
  createRecordConsistencyView,
  formatListValue,
  renderDuplicateNameRow,
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
    docdb_id: 'id-001',
    docdb_version: 'v2',
    name: 'asset-one',
    location: 's3://aind-data/asset-one/',
  },
  {
    docdb_id: 'id-002',
    docdb_version: 'v2',
    name: 'asset-one',
    location: 's3://aind-data/asset-two/',
  },
];

describe('record-consistency view helpers', () => {
  it('queries only failed v2 duplicate-name flags', () => {
    const sql = buildDuplicateNameQuery('record_consistency_checks');
    expect(sql).toContain('FROM "record_consistency_checks"');
    expect(sql).toContain("check_key = 'docdb_duplicate_name_v2'");
    expect(sql).toContain("docdb_version = 'v2'");
    expect(sql).toContain("status = 'fail'");
    expect(sql).toContain('ORDER BY name ASC, docdb_id ASC');
    expect(sql).not.toContain('peer_docdb_ids');
    expect(sql).not.toContain('duplicate_group_count');
  });

  it('derives group sizes and peer IDs from result rows', () => {
    expect(addDuplicateGroupDetails(ROWS)).toEqual([
      { ...ROWS[0], duplicate_group_count: 2, peer_docdb_ids: ['id-002'] },
      { ...ROWS[1], duplicate_group_count: 2, peer_docdb_ids: ['id-001'] },
    ]);
  });

  it('formats list-valued and scalar peer IDs', () => {
    expect(formatListValue(['id-001', 'id-002'])).toBe('id-001, id-002');
    expect(formatListValue('id-001')).toBe('id-001');
    expect(formatListValue(null)).toBe('');
  });

  it('counts duplicate groups by exact flagged name', () => {
    expect(countDuplicateNameGroups(ROWS)).toBe(1);
    expect(countDuplicateNameGroups([...ROWS, { name: 'asset-two' }])).toBe(2);
  });

  it('escapes row content and links metadata and S3 location', () => {
    const html = renderDuplicateNameRow({
      ...addDuplicateGroupDetails(ROWS)[0],
      name: '"><img src=x>',
      docdb_id: 'id"><script>',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
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
    expect(queryRows).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("status = 'fail'"));
    expect(root.textContent).toContain('2 flagged v2 record(s) across 1 duplicate name group(s).');
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('renders an explicit empty state', async () => {
    queryRows.mockResolvedValue([]);
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain('No flagged v2 duplicate-name records.'));
    expect(root.querySelector('table')).toBeNull();
  });

  it('renders a useful load error', async () => {
    ensureTable.mockRejectedValue(new Error('missing registry entry'));
    const root = createRecordConsistencyView({ query: vi.fn() });
    await vi.waitFor(() => expect(root.textContent).toContain('Failed to load record-consistency checks'));
    expect(root.querySelector('.loading-message.error')).not.toBeNull();
  });
});
