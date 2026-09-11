import { describe, expect, it } from 'vitest';
import { assetNamesForQcRows, buildSourceDataQuery, findRawAssetName, findRawAssetNames } from '../qc/lineage.js';

const sources = [
  { name: 'processed', source_data: 'raw' },
  { name: 'analysis', source_data: 'processed' },
  { name: 'second-derived', source_data: 'raw' },
];

describe('QC asset lineage', () => {
  it('follows a derived chain to its raw root', () => {
    expect(findRawAssetName('analysis', sources)).toBe('raw');
    expect(findRawAssetNames('analysis', sources)).toEqual(['raw']);
  });

  it('leaves raw assets unchanged and returns all roots for a merge', () => {
    expect(findRawAssetName('raw', sources)).toBe('raw');
    expect(findRawAssetNames('merged', [
      ...sources,
      { name: 'merged', source_data: ['raw-a', 'raw-b'] },
    ])).toEqual(['raw-a', 'raw-b']);
  });

  it('does not recurse forever on malformed cyclic source data', () => {
    expect(findRawAssetNames('a', [{ name: 'a', source_data: 'b' }, { name: 'b', source_data: 'a' }])).toEqual(['a']);
  });

  it('collects origin and downstream assets from cached rows', () => {
    expect(assetNamesForQcRows([
      { asset_name: 'raw', downstream_asset_names: ['processed'] },
      { asset_name: 'processed', downstream_asset_names: ['analysis'] },
    ])).toEqual(['raw', 'processed', 'analysis']);
  });

  it('builds a source-data query scoped to the requested asset names', () => {
    expect(buildSourceDataQuery(["derived'asset", 'derived-asset'])).toBe(
      "SELECT name, source_data FROM source_data WHERE name IN ('derived''asset', 'derived-asset')",
    );
  });
});
