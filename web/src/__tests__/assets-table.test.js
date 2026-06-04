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
