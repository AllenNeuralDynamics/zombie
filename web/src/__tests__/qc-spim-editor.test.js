/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/qc-spa-auth.js', () => ({
  getQcAccount: async () => ({ name: 'QC reviewer' }),
  accountDisplayName: account => account.name,
}));

import { mountQcEditor, readQcPendingChanges } from '../qc/editor.js';

const record = {
  name: 'SmartSPIM_new_asset',
  location: 's3://aind-open-data/SmartSPIM_new_asset',
  data_description: { data_level: 'derived' },
  instrument: { instrument_id: 'SmartSPIM' },
};
let unmount;
afterEach(() => {
  unmount?.();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function openSettings() {
  const container = document.createElement('div');
  unmount = mountQcEditor(container, record);
  await vi.waitFor(() => expect(container.querySelector('.qc-settings-btn')).toBeTruthy());
  container.querySelector('.qc-settings-btn').click();
  await vi.waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy());
  const addButton = [...container.querySelectorAll('button')]
    .find(button => button.textContent.includes('Add SPIM QC metrics'));
  return { container, addButton };
}

describe('adding SPIM QC metrics', () => {
  it('waits for S3 and queues metrics with its link for an asset without QC', async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise(resolve => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchImpl);
    const { container, addButton } = await openSettings();
    addButton.click();
    await vi.waitFor(() => expect(addButton.disabled).toBe(true));
    expect(readQcPendingChanges(record.name)?.addedMetrics ?? []).toEqual([]);
    resolveFetch({ ok: true, json: async () => ({ ng_link: 'https://neuroglancer.example/#!s3' }) });
    await vi.waitFor(() => expect(container.textContent).toContain('Queued 5 SPIM QC metrics'));
    await vi.waitFor(() => {
      const metrics = readQcPendingChanges(record.name)?.addedMetrics;
      expect(metrics).toHaveLength(5);
      expect(metrics.every(metric => metric.reference === 'https://neuroglancer.example/#!s3')).toBe(true);
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://aind-open-data.s3.amazonaws.com/SmartSPIM_new_asset/neuroglancer_config.json');
  });

  it('shows a config error without queuing metrics and permits retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const { container, addButton } = await openSettings();
    addButton.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Could not add SPIM QC metrics:'));
    expect(readQcPendingChanges(record.name)?.addedMetrics ?? []).toEqual([]);
    expect(addButton.disabled).toBe(false);
  });
});
