/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKS_QUERY,
  createRecordConsistencyView,
  FINDINGS_QUERY,
  readTableState,
  recordHref,
  renderCheckRow,
  renderFindingRow,
  tableStateSearch,
} from '../record_consistency/view.js';

vi.mock('../lib/arrow.js', () => ({
  queryRows: vi.fn(),
}));

vi.mock('../lib/registry.js', () => ({
  ensureTable: vi.fn(async (_coord, name) => name),
}));

vi.mock('../lib/utils.js', async (importOriginal) => ({
  ...await importOriginal(),
  downloadCsv: vi.fn(),
}));

import { queryRows } from '../lib/arrow.js';
import { downloadCsv } from '../lib/utils.js';

const SOURCE_URL = 'https://github.com/AllenNeuralDynamics/biodata-cache/blob/v0.43.0/'
  + 'src/biodata_cache/cache_table_helpers/record_consistency.py#L33';

const CHECKS = [
  {
    check_key: 'docdb_duplicate_name_v2',
    description: 'Fails every DocDB v2 record whose non-empty `name` exactly matches another v2 record.',
    source_url: SOURCE_URL,
    evaluated: 105035,
    flagged: 2,
    checked_at: '2026-09-30T09:00:00+00:00',
  },
  {
    check_key: 'docdb_v1_name_missing_in_v2',
    description: 'Fails every DocDB v1 record whose non-empty `name` has zero exact matches in DocDB v2.',
    source_url: 'javascript:alert(1)',
    evaluated: 118418,
    flagged: 1,
    checked_at: '2026-09-30T09:00:00+00:00',
  },
];

const FINDINGS = [
  {
    name: 'asset-one',
    check_key: 'docdb_duplicate_name_v2',
    status: 'fail',
    record_kind: 'docdb_v2',
    record_id: 'id-002',
    location: 's3://aind-data/asset-one-b/',
    record_last_modified: '2026-09-01T10:00:00Z',
  },
  {
    name: 'asset-one',
    check_key: 'docdb_duplicate_name_v2',
    status: 'fail',
    record_kind: 'docdb_v2',
    record_id: 'id-001',
    location: 's3://aind-data/asset-one-a/',
    record_last_modified: '2026-09-02T10:00:00Z',
  },
  {
    name: 'legacy-asset',
    check_key: 'docdb_v1_name_missing_in_v2',
    status: 'fail',
    record_kind: 'docdb_v1',
    record_id: 'v1-001',
    location: null,
    record_last_modified: null,
  },
];

function mockQueries(checks = CHECKS, findings = FINDINGS) {
  queryRows.mockImplementation(async (_coord, sql) => (sql === CHECKS_QUERY ? checks : findings));
}

function bodyRows(view) {
  return [...view.querySelectorAll('.assets-table tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent.trim()));
}

beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, '', '/record-consistency');
});

describe('record-consistency helpers', () => {
  it('reads only the non-pass findings from the registered table', () => {
    expect(FINDINGS_QUERY).toContain('FROM record_consistency_checks');
    expect(FINDINGS_QUERY).toContain("WHERE status <> 'pass'");
    expect(CHECKS_QUERY).toContain('GROUP BY check_key');
  });

  it('links v2 findings to /record and v1 findings to /upgrade', () => {
    expect(recordHref(FINDINGS[0])).toBe('/record?name=asset-one');
    expect(recordHref(FINDINGS[2])).toBe('/upgrade?asset_id=v1-001');
    expect(recordHref({ record_kind: 'docdb_v1', record_id: null })).toBeNull();
  });

  it('escapes finding values and links the S3 location', () => {
    const html = renderFindingRow({
      ...FINDINGS[0],
      name: '<img src=x onerror=alert(1)>',
      record_id: '<b>id</b>',
      location: 's3://bucket/"quoted"/',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('https://s3.console.aws.amazon.com/s3/buckets/bucket?prefix=&quot;quoted&quot;/');
    expect(html).toContain('badge badge-no');
  });

  it('links a check to its source only for GitHub URLs', () => {
    expect(renderCheckRow(CHECKS[0])).toContain(`href="${SOURCE_URL}"`);
    expect(renderCheckRow(CHECKS[1])).not.toContain('href=');
    expect(renderCheckRow(CHECKS[1])).toContain('118,418');
  });

  it('round-trips table state and omits defaults from the URL', () => {
    const state = readTableState('?sort=name&dir=desc&page=2&f_status=fail&f_unknown=x');
    expect(state).toMatchObject({ sort: 'name', dir: 'desc', page: 2 });
    expect(state.filters.status).toBe('fail');
    expect(state.filters).not.toHaveProperty('unknown');
    expect(tableStateSearch(state)).toBe('sort=name&dir=desc&page=2&f_status=fail');
    expect(tableStateSearch(readTableState(''))).toBe('');
  });
});

describe('createRecordConsistencyView', () => {
  it('summarizes each check and lists its findings in query order', async () => {
    mockQueries();

    const view = await createRecordConsistencyView({});

    const checkRows = [...view.querySelectorAll('.sessions-stat-table tbody tr')];
    expect(checkRows).toHaveLength(2);
    expect(checkRows[0].textContent).toContain('docdb_duplicate_name_v2');
    expect(checkRows[0].textContent).toContain('105,035');
    expect(checkRows[0].textContent).toContain('2026-09-30 09:00');
    expect(bodyRows(view).map((row) => row[4])).toEqual(['id-002', 'id-001', 'v1-001']);
    expect(view.querySelector('.page-info').textContent).toBe('1–3 of 3');
    expect(window.location.search).toBe('');
  });

  it('sorts by a clicked column and records the sort in the URL', async () => {
    mockQueries();
    const view = await createRecordConsistencyView({});

    view.querySelector('th[data-col="record_id"]').click();

    expect(bodyRows(view).map((row) => row[4])).toEqual(['id-001', 'id-002', 'v1-001']);
    expect(window.location.search).toBe('?sort=record_id');

    view.querySelector('th[data-col="record_id"]').click();

    expect(bodyRows(view).map((row) => row[4])).toEqual(['v1-001', 'id-002', 'id-001']);
    expect(window.location.search).toBe('?sort=record_id&dir=desc');
  });

  it('restores filters from the URL and exports only the filtered rows', async () => {
    history.replaceState(null, '', '/record-consistency?f_record_kind=docdb_v1');
    mockQueries();
    const view = await createRecordConsistencyView({});

    expect(bodyRows(view)).toHaveLength(1);
    expect(view.querySelector('select.col-filter[data-col="record_kind"]').value).toBe('docdb_v1');

    view.querySelector('.sessions-export-btn').click();

    expect(downloadCsv).toHaveBeenCalledWith(
      'record-consistency.csv',
      ['Name', 'Check', 'Status', 'Record Kind', 'Record ID', 'Location', 'Last Modified'],
      [['legacy-asset', 'docdb_v1_name_missing_in_v2', 'fail', 'docdb_v1', 'v1-001', '', '']],
    );
  });

  it('filters as the user types and resets to the first page', async () => {
    const many = Array.from({ length: 150 }, (_, index) => ({
      ...FINDINGS[0],
      name: `asset-${String(index).padStart(3, '0')}`,
      recordrecord_id: `id-${String(index).padStart(3, '0')}`,
    }));
    mockQueries(CHECKS, many);
    const view = await createRecordConsistencyView({});

    view.querySelector('.page-btn[data-page="1"]').click();
    expect(view.querySelector('.page-info').textContent).toBe('101–150 of 150');
    expect(window.location.search).toBe('?page=1');

    const input = view.querySelector('input.col-filter[data-col="name"]');
    input.value = 'asset-14';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(view.querySelector('.page-info').textContent).toBe('1–10 of 10');
    expect(window.location.search).toBe('?f_name=asset-14');
  });

  it('shows an empty state when every record passes', async () => {
    mockQueries(CHECKS, []);

    const view = await createRecordConsistencyView({});

    expect(view.querySelector('.assets-table')).toBeNull();
    expect(view.textContent).toContain('No flagged records.');
  });

  it('ignores a URL filter value that no row has', async () => {
    history.replaceState(null, '', '/record-consistency?f_status=unknown');
    mockQueries();
    const view = await createRecordConsistencyView({});

    expect(bodyRows(view)).toHaveLength(3);
    expect(window.location.search).toBe('');
  });

  it('keeps the pager when a change event repeats the typed filter value', async () => {
    mockQueries();
    const view = await createRecordConsistencyView({});
    const input = view.querySelector('.col-filter[data-col="name"]');
    input.value = 'legacy-asset';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const pager = view.querySelector('.assets-paging .page-btn');

    input.dispatchEvent(new Event('change', { bubbles: true }));

    expect(view.querySelector('.assets-paging .page-btn')).toBe(pager);
  });

  it('propagates query failures to bootstrap', async () => {
    queryRows.mockRejectedValue(new Error('Catalog Error: table does not exist'));

    await expect(createRecordConsistencyView({})).rejects.toThrow('Catalog Error');
  });
});
