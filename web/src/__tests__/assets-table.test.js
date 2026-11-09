/**
 * assets-table.test.js — Tests for buildAssetsTable in lib/assets-table.js.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from 'vitest';
import { buildAssetsTable } from '../lib/assets-table.js';

function makeAsset(name) {
  return { name, subject_id: '42', acquisition_start_time: '2024-01-01T10:00:00Z', modalities: 'Ephys', data_level: 'raw', code_ocean: null, location: null };
}

describe('buildAssetsTable — goToAsset', () => {
  it('highlights the target row', () => {
    const assets = [makeAsset('asset-a'), makeAsset('asset-b')];
    const wrapper = buildAssetsTable(assets, null);
    document.body.appendChild(wrapper);

    wrapper.goToAsset('asset-a');
    const row = wrapper.querySelector('tr[data-asset-name="asset-a"]');
    expect(row.classList.contains('asset-highlighted')).toBe(true);

    document.body.innerHTML = '';
  });

  it('clears the previous highlight when a new asset is selected', () => {
    const assets = [makeAsset('asset-a'), makeAsset('asset-b')];
    const wrapper = buildAssetsTable(assets, null);
    document.body.appendChild(wrapper);

    wrapper.goToAsset('asset-a');
    wrapper.goToAsset('asset-b');

    const rowA = wrapper.querySelector('tr[data-asset-name="asset-a"]');
    const rowB = wrapper.querySelector('tr[data-asset-name="asset-b"]');
    expect(rowA.classList.contains('asset-highlighted')).toBe(false);
    expect(rowB.classList.contains('asset-highlighted')).toBe(true);

    document.body.innerHTML = '';
  });

  it('clearHighlights removes all highlighted rows', () => {
    const assets = [makeAsset('asset-a'), makeAsset('asset-b')];
    const wrapper = buildAssetsTable(assets, null);
    document.body.appendChild(wrapper);

    wrapper.goToAsset('asset-a');
    wrapper.clearHighlights();

    const rowA = wrapper.querySelector('tr[data-asset-name="asset-a"]');
    expect(rowA.classList.contains('asset-highlighted')).toBe(false);

    document.body.innerHTML = '';
  });
});

describe('buildAssetsTable — asset links', () => {
  it('links asset names to the canonical asset view', () => {
    const wrapper = buildAssetsTable([makeAsset('asset with spaces')], null);
    const link = wrapper.querySelector('tbody td a');

    expect(link.textContent).toBe('asset with spaces');
    expect(link.getAttribute('href')).toBe('/view?asset=asset%20with%20spaces');
  });
});

describe('buildAssetsTable — grouping and pagination', () => {
  it('preserves parent order, multiple parents, and assets with missing parents', () => {
    const assets = ['raw-a', 'child', 'raw-b', 'orphan'].map(makeAsset);
    const wrapper = buildAssetsTable(assets, {
      child: ['raw-a', 'raw-b'],
      orphan: ['missing-parent'],
    });
    const rows = [...wrapper.querySelectorAll('tbody tr')];
    expect(rows.map(row => row.dataset.assetName)).toEqual(['raw-a', 'child', 'raw-b', 'child', 'orphan']);
    expect(rows.map(row => row.classList.contains('asset-derived-row'))).toEqual([false, true, false, true, false]);
  });

  it('pages independent assets and jumps to a highlighted asset on another page', () => {
    const assets = Array.from({ length: 102 }, (_, i) => makeAsset(`asset-${i}`));
    const wrapper = buildAssetsTable(assets, null);
    expect(wrapper.querySelectorAll('tbody tr')).toHaveLength(100);
    wrapper.querySelector('#at-next').click();
    expect([...wrapper.querySelectorAll('tbody tr')].map(row => row.dataset.assetName)).toEqual(['asset-100', 'asset-101']);
    wrapper.querySelector('#at-prev').click();
    wrapper.goToAsset('asset-101');
    expect(wrapper.querySelector('.asset-highlighted').dataset.assetName).toBe('asset-101');
    expect(wrapper.querySelector('.page-info').textContent).toBe('101–102 of 102');
  });
});
