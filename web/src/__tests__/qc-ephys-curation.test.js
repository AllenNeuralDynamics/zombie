/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import { renderMetrics } from '../qc/metrics.js';
import {
  buildEphysCurationUrl,
  renderEphysCuration,
} from '../qc/ephys-curation.js';

const ASSET = 'ecephys_820459_2025-11-10_15-07-13_sorted-curation-sprint_2026-09-19_03-56-30';
const RAW_ASSET = 'ecephys_820459_2025-11-10_15-07-13';
const REFERENCE = 'https%3A//ephys.allenneuraldynamics.org/ephys_gui_app%3Fanalyzer_path%3D%7Bderived_asset_location%7D/postprocessed/experiment1_Record%20Node%20101%23Neuropix-PXI-100.ProbeA-AP_recording1.zarr%26recording_path%3D%7Braw_asset_location%7D/ecephys/ecephys_compressed/experiment1_Record%20Node%20101%23Neuropix-PXI-100.ProbeA-AP.zarr';

function metric(overrides = {}) {
  return {
    name: 'Sorting Curation - experiment1_ProbeA-AP',
    object_type: 'Curation metric',
    type: 'Spike sorting curation',
    value: [{ unit_ids: [1, 2], labels: { quality: ['good'] } }],
    curation_history: [{ curator: 'Ephys pipeline', timestamp: '2026-09-19 02:47:54.733570+00:00' }],
    reference: REFERENCE,
    status_history: [{ status: 'Pass' }],
    ...overrides,
  };
}

describe('ephys curation URL construction', () => {
  it('decodes the stored reference, substitutes both S3 locations, and adds GUI identity parameters', () => {
    const url = buildEphysCurationUrl(REFERENCE, {
      s3Bucket: 'aind-open-data',
      s3Prefix: ASSET,
      rawS3Loc: `s3://aind-open-data/${RAW_ASSET}`,
      identifier: 'curation-instance-1',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://ephys.allenneuraldynamics.org');
    expect(parsed.pathname).toBe('/ephys_gui_app');
    expect(parsed.searchParams.get('analyzer_path')).toBe(
      `s3://aind-open-data/${ASSET}/postprocessed/experiment1_Record Node 101#Neuropix-PXI-100.ProbeA-AP_recording1.zarr`,
    );
    expect(parsed.searchParams.get('recording_path')).toBe(
      `s3://aind-open-data/${RAW_ASSET}/ecephys/ecephys_compressed/experiment1_Record Node 101#Neuropix-PXI-100.ProbeA-AP.zarr`,
    );
    expect(parsed.searchParams.get('identifier')).toBe('curation-instance-1');
    expect(parsed.searchParams.get('session')).toBe(ASSET);
    expect(url).not.toContain('%253A');
    expect(url).not.toContain('{derived_asset_location}');
    expect(url).not.toContain('{raw_asset_location}');
  });
});

describe('ephys curation iframe communication', () => {
  it('renders a dedicated curation iframe instead of the generic media iframe', () => {
    const view = renderMetrics(
      [metric()],
      'aind-open-data',
      ASSET,
      ASSET,
      `s3://aind-open-data/${RAW_ASSET}`,
    );

    expect(view.querySelector('.qc-ephys-curation')).toBeTruthy();
    expect(view.querySelector('.qc-ephys-curation-iframe')).toBeTruthy();
    expect(view.querySelector('.qc-media')).toBeNull();
    expect(view.querySelector('.qc-ephys-curation-iframe').getAttribute('src')).toContain(
      `analyzer_path=s3://aind-open-data/${ASSET}/postprocessed/`,
    );
  });

  it('sends the selected curation to the iframe using its identifier', () => {
    const panel = renderEphysCuration(metric(), {
      s3Bucket: 'aind-open-data',
      s3Prefix: ASSET,
      rawS3Loc: `s3://aind-open-data/${RAW_ASSET}`,
      identifier: 'curation-instance-2',
    });
    const iframe = panel.querySelector('iframe');
    const contentWindow = { postMessage: vi.fn() };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: contentWindow });

    panel.querySelector('.qc-ephys-curation-send').click();

    expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'curation-data',
      identifier: 'curation-instance-2',
      data: { unit_ids: [1, 2], labels: { quality: ['good'] } },
    }), '*');
    expect(contentWindow.postMessage.mock.calls[0][0]._nonce).toEqual(expect.any(String));
  });

  it('accepts only matching iframe messages and forwards new curations to the editor', () => {
    const onCuration = vi.fn();
    const panel = renderEphysCuration(metric(), {
      identifier: 'curation-instance-3',
      edit: { enabled: true, onCuration },
    });
    const iframe = panel.querySelector('iframe');
    const contentWindow = {};
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: contentWindow });

    window.dispatchEvent(new MessageEvent('message', {
      source: contentWindow,
      data: {
        type: 'curation-data',
        identifier: 'wrong-instance',
        data: { unit_ids: [99] },
      },
    }));
    expect(onCuration).not.toHaveBeenCalled();

    const next = { unit_ids: [3], labels: { quality: ['good'] } };
    window.dispatchEvent(new MessageEvent('message', {
      source: contentWindow,
      data: { type: 'curation-data', identifier: 'curation-instance-3', data: next },
    }));

    expect(onCuration).toHaveBeenCalledWith(metric().name, next);
    expect(panel.querySelector('.qc-ephys-curation-select').options).toHaveLength(2);
    expect(panel.querySelector('.qc-ephys-curation-metadata').textContent).toBe('Pending curation');
    expect(panel.querySelector('.qc-ephys-curation-json').textContent).toContain('"unit_ids"');
  });
});
