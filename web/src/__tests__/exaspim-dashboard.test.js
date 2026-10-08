// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createExaSpimView } from '../exaspim/view.js';
import { createIntermediatesLoader, folderStatus, renderIntermediateDetails, intermediatesDeletedStatus } from '../exaspim/intermediates.js';
import { ensureTable, getAcorn } from '../lib/registry.js';
import { queryRows } from '../lib/arrow.js';

vi.mock('../lib/registry.js', () => ({ ensureTable: vi.fn(), getAcorn: vi.fn() }));
vi.mock('../lib/arrow.js', () => ({ queryRows: vi.fn() }));
vi.mock('../lib/platform-overview.js', () => ({ createPlatformOverview: () => document.createElement('div') }));
vi.mock('../exaspim/morphology.js', () => ({ createExaSpimMorphologySection: () => document.createElement('details') }));
const platform = [
  { raw_name: 'raw-a', name: 'fused-a', subject_id: '1', processed: true },
  { raw_name: 'raw-b', name: 'raw-b', subject_id: '2', processed: false },
];
const checks = [
  { raw_name: 'raw-a', name: 'processed-a', location: 's3://aind-open-data/processed-a', flatfield_present: true, denoised_present: false, checked_at: '2026-10-08 12:00:00+00' },
  { raw_name: 'raw-a', name: 'processed-a-older', flatfield_present: false, denoised_present: null, status: 's3_error' },
  { raw_name: 'raw-b', name: null, status: 'no_processed' },
];
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  ensureTable.mockResolvedValue(undefined);
  getAcorn.mockReturnValue({ name: 'platform_exaspim_intermediates' });
  queryRows.mockImplementation((_coord, sql) => Promise.resolve(sql.includes('FROM platform_exaspim_intermediates') ? checks : platform));
});
afterEach(() => document.body.replaceChildren());
async function mount() {
  const view = createExaSpimView({});
  document.body.appendChild(view);
  await vi.waitFor(() => expect(view.querySelectorAll('[data-exaspim-expand]')).toHaveLength(2));
  return view;
}
function expand(view, key) {
  [...view.querySelectorAll('[data-exaspim-expand]')].find((el) => el.dataset.exaspimExpand === key).click();
}
it('loads the optional cache once on expansion and groups every processed asset by raw acquisition', async () => {
  const view = await mount();
  expect(ensureTable).not.toHaveBeenCalledWith(expect.anything(), 'platform_exaspim_intermediates');
  expect(view.querySelector('[data-exaspim-expand]').getAttribute('aria-expanded')).toBe('false');
  expand(view, 'raw-a');
  await vi.waitFor(() => expect(view.querySelectorAll('.exaspim-intermediate-asset')).toHaveLength(2));
  const details = view.querySelector('[data-exaspim-intermediates]');
  expect(details.textContent).toContain('Present');
  expect(details.textContent).toContain('Deleted / absent');
  expect(details.textContent).toContain('Unknown');
  expect(details.textContent).toContain('2026-10-08 12:00');
  expect(details.querySelector('a').href).toContain('processed-a');
  expand(view, 'raw-b');
  expect(view.textContent).toContain('No processed asset was found');
  expect(queryRows.mock.calls.filter(([, sql]) => sql.includes('FROM platform_exaspim_intermediates'))).toHaveLength(1);
  expand(view, 'raw-a');
  expect(view.querySelector('[data-exaspim-expand="raw-a"]').getAttribute('aria-expanded')).toBe('false');
});
it('keeps expanded rows open and the detail colspan correct after changing visible columns', async () => {
  const view = await mount();
  expand(view, 'raw-a');
  await vi.waitFor(() => expect(view.querySelectorAll('.exaspim-intermediate-asset')).toHaveLength(2));
  view.querySelector('.assets-settings-btn').click();
  const checkbox = document.querySelector('[data-col="genotype"].settings-col-checkbox');
  checkbox.checked = false;
  checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  expect(view.querySelector('[data-exaspim-expand="raw-a"]').getAttribute('aria-expanded')).toBe('true');
  expect(view.querySelector('.exaspim-detail-row td').colSpan).toBe(view.querySelector('thead tr').children.length);
  expect(view.querySelectorAll('.exaspim-intermediate-asset')).toHaveLength(2);
  document.querySelector('.settings-close-btn').click();
});
it('shows a missing-cache error without blocking the main asset table', async () => {
  getAcorn.mockReturnValue(undefined);
  const view = await mount();
  expand(view, 'raw-a');
  await vi.waitFor(() => expect(view.textContent).toContain('Intermediate folder cache is unavailable'));
  expect(view.querySelectorAll('[data-exaspim-expand]')).toHaveLength(2);
});
it('shows query errors, sanitizes request parameters, and permits retry', async () => {
  let fail = true;
  queryRows.mockImplementation((_coord, sql) => {
    if (!sql.includes('FROM platform_exaspim_intermediates')) return Promise.resolve(platform);
    return fail ? Promise.reject(new Error('https://example.com/file?token=secret')) : Promise.resolve(checks);
  });
  const view = await mount();
  expand(view, 'raw-a');
  await vi.waitFor(() => expect(view.textContent).toContain('Failed to load intermediate folders'));
  expect(view.textContent).not.toContain('secret');
  fail = false;
  expand(view, 'raw-a');
  expand(view, 'raw-a');
  await vi.waitFor(() => expect(view.querySelectorAll('.exaspim-intermediate-asset')).toHaveLength(2));
  expect(view.querySelector('[data-exaspim-intermediates]').classList.contains('error')).toBe(false);
});
it('distinguishes unknown checks and missing inventory, and escapes asset names', () => {
  expect(folderStatus(true)).toBe('Present');
  expect(folderStatus(false)).toBe('Deleted / absent');
  expect(folderStatus(null)).toBe('Unknown');
  expect(folderStatus(undefined)).toBe('Unknown');
  expect(renderIntermediateDetails([{ ...checks[0], name: '<script>oops</script>' }])).not.toContain('<script>');
  expect(renderIntermediateDetails([])).toContain('No intermediate folder checks');
  expect(renderIntermediateDetails([{ name: 'bad', status: 'invalid_location' }])).toContain('no valid S3 location');
});
it('shares the loading promise for simultaneous expansions', async () => {
  const loader = createIntermediatesLoader({});
  expect(loader()).toBe(loader());
  expect((await loader()).get('raw-a')).toHaveLength(2);
  expect(queryRows).toHaveBeenCalledTimes(1);
});

it('reports cleanup across every downstream asset without treating unknown checks as deleted', () => {
  const deleted = { flatfield_present: false, denoised_present: false };
  expect(intermediatesDeletedStatus([deleted, { ...deleted }])).toBe('Yes');
  expect(intermediatesDeletedStatus([deleted, { ...deleted, denoised_present: true }])).toBe('No');
  expect(intermediatesDeletedStatus([deleted, { ...deleted, flatfield_present: null }])).toBe('Unknown');
  expect(intermediatesDeletedStatus(checks.slice(0, 2))).toBe('No');
  expect(intermediatesDeletedStatus([])).toBe('Unknown');
  expect(intermediatesDeletedStatus([{ status: 'no_processed' }])).toBe('No processed assets');
});

it('defaults cleanup off, saves enabled columns, restores them on remount, and persists reset', async () => {
  const view = await mount();
  expect(view.querySelector('th.exaspim-expand-cell').textContent).toBe('Expanddetails');
  expect(view.querySelector('[data-exaspim-expand]').textContent).toBe('›');
  expect(view.querySelector('th[data-col="intermediates_deleted"]')).toBeNull();
  view.querySelector('.assets-settings-btn').click();
  const checkbox = document.querySelector('.settings-col-checkbox[data-col="intermediates_deleted"]');
  expect(checkbox.checked).toBe(false);
  checkbox.click();
  await vi.waitFor(() => expect(view.querySelector('tbody').textContent).toContain('No processed assets'));
  expect(view.querySelector('th[data-col="intermediates_deleted"]')).not.toBeNull();
  expect(view.querySelector('tbody tr td:nth-last-child(2)').textContent).toBe('No');
  document.querySelector('.settings-close-btn').click();
  view.remove();
  const restored = await mount();
  await vi.waitFor(() => expect(restored.querySelector('tbody').textContent).toContain('No processed assets'));
  expect(restored.querySelector('th[data-col="intermediates_deleted"]')).not.toBeNull();
  restored.querySelector('.assets-settings-btn').click();
  expect(document.querySelector('.settings-col-checkbox[data-col="intermediates_deleted"]').checked).toBe(true);
  document.querySelector('.settings-reset-btn').click();
  document.querySelector('.settings-close-btn').click();
  restored.remove();
  const reset = await mount();
  expect(reset.querySelector('th[data-col="intermediates_deleted"]')).toBeNull();
});
