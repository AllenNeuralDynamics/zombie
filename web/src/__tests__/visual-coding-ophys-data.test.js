import { describe, expect, it } from 'vitest';
import {
  VCO_PATHS,
  assertVisualCodingAssetName,
  findVisualCodingNwbPrefix,
} from '../visual_coding_ophys/data.js';

const ASSET = '388801_2018-06-28_11-06-40_nwb_2026-08-19_17-42-24';

describe('Visual Coding Ophys NWB discovery', () => {
  it('finds the canonical asset NWB-Zarr root', () => {
    const xml = `<CommonPrefixes><Prefix>${ASSET}/${ASSET}.nwb.zarr/</Prefix></CommonPrefixes>`;
    expect(findVisualCodingNwbPrefix(xml, ASSET)).toBe(`${ASSET}/${ASSET}.nwb.zarr/`);
  });

  it('rejects unsafe asset names before a request', () => {
    expect(() => assertVisualCodingAssetName('../not-an-asset')).toThrow(/Invalid Visual Coding Ophys asset name/);
  });

  it('keeps the legacy single-plane paths local to this adapter', () => {
    expect(VCO_PATHS.dff).toBe('processing/ophys/DfOverF/DfOverF/data');
    expect(VCO_PATHS.timestamps).toBe('processing/ophys/Fluorescence/Corrected/timestamps');
    expect(VCO_PATHS.roiIds).toContain('PlaneSegmentation/id');
  });
});
