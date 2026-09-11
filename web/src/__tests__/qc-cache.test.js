import { describe, expect, it } from 'vitest';
import { buildQcPartitionQuery } from '../qc/cache.js';

const acorn = {
  location: 's3://allen-data-views/data-asset-cache/bdc-v0.42/qc/',
  partitioned: true,
  partition_key: 'raw_asset_name',
};

describe('QC cache partition query', () => {
  it('reads only the requested raw-asset partition', () => {
    const sql = buildQcPartitionQuery(acorn, 'raw_asset_123');

    expect(sql).toBe(
      "SELECT * FROM read_parquet('https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/bdc-v0.42/qc/raw_asset_name=raw_asset_123/data.pqt', hive_partitioning=true)",
    );
    expect(sql).not.toContain('**');
  });

  it('escapes asset names used as SQL literals', () => {
    const sql = buildQcPartitionQuery(acorn, "raw_asset'123");

    expect(sql).toContain("raw_asset''123/data.pqt");
  });

  it('rejects a registry entry with the wrong partition key', () => {
    expect(() => buildQcPartitionQuery({ ...acorn, partition_key: 'subject_id' }, 'raw'))
      .toThrow('raw_asset_name');
  });
});
