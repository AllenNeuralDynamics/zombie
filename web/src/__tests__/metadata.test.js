/**
 * metadata.test.js — Unit tests for pure functions in metadata.js.
 *
 * DB-dependent functions (fetchAndRegisterMetadata, registerAcornTable,
 * dropAcornTable) are NOT tested here — they require a live DuckDB-WASM
 * coordinator.  Integration tests for those belong in a future Playwright /
 * browser-test suite.
 */

import { describe, it, expect } from 'vitest';
import {
  validateAcorn,
  parseSquirrelJson,
  s3PathToHttps,
  buildParquetArg,
  buildRegisterSql,
  ACORN_COLUMN_CASTS,
  getMetadataAcorns,
  getAssetAcorns,
  getAcornByName,
} from '../lib/metadata.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const METADATA_ACORN = {
  name: 'asset_basics',
  location: 's3://allen-data-views/data-asset-cache/zs_asset_basics.pqt',
  partitioned: false,
  partition_key: null,
  type: 'metadata',
  columns: ['_id', 'project_name', 'subject_id'],
};

const ASSET_ACORN_PARTITIONED = {
  name: 'quality_control',
  location: 's3://allen-data-views/data-asset-cache/zs_qc/',
  partitioned: true,
  partition_key: 'subject_id',
  type: 'asset',
  columns: ['name', 'stage', 'value'],
};

const SAMPLE_SQUIRREL = {
  acorns: [METADATA_ACORN, ASSET_ACORN_PARTITIONED],
};

// ---------------------------------------------------------------------------
// validateAcorn
// ---------------------------------------------------------------------------

describe('validateAcorn', () => {
  it('accepts a valid metadata acorn without throwing', () => {
    expect(() => validateAcorn(METADATA_ACORN)).not.toThrow();
  });

  it('accepts a valid asset acorn without throwing', () => {
    expect(() => validateAcorn(ASSET_ACORN_PARTITIONED)).not.toThrow();
  });

  it('throws when acorn is not an object', () => {
    expect(() => validateAcorn('string')).toThrow(/must be an object/);
    expect(() => validateAcorn(null)).toThrow(/must be an object/);
    expect(() => validateAcorn(42)).toThrow(/must be an object/);
  });

  it('throws when a required field is missing', () => {
    const { name: _name, ...noName } = METADATA_ACORN;
    expect(() => validateAcorn(noName)).toThrow(/missing required field "name"/);

    const { columns: _cols, ...noCols } = METADATA_ACORN;
    expect(() => validateAcorn(noCols)).toThrow(/missing required field "columns"/);
  });

  it('throws when columns is not an array', () => {
    expect(() => validateAcorn({ ...METADATA_ACORN, columns: 'not-an-array' }))
      .toThrow(/columns must be an array/);
  });

  it('throws when type is not "metadata" or "asset"', () => {
    expect(() => validateAcorn({ ...METADATA_ACORN, type: 'unknown' }))
      .toThrow(/type must be "metadata" or "asset"/);
  });

  it('includes the index in the error label when provided', () => {
    try {
      validateAcorn('bad', 3);
    } catch (err) {
      expect(err.message).toContain('acorns[3]');
    }
  });
});

// ---------------------------------------------------------------------------
// parseSquirrelJson
// ---------------------------------------------------------------------------

describe('parseSquirrelJson', () => {
  it('returns the same object when valid', () => {
    const result = parseSquirrelJson({ ...SAMPLE_SQUIRREL });
    expect(result.acorns).toHaveLength(2);
  });

  it('throws when input is not an object', () => {
    expect(() => parseSquirrelJson('string')).toThrow(/must be a JSON object/);
    expect(() => parseSquirrelJson(null)).toThrow(/must be a JSON object/);
  });

  it('throws when "acorns" key is missing', () => {
    expect(() => parseSquirrelJson({})).toThrow(/must have an "acorns" array/);
  });

  it('throws when "acorns" is not an array', () => {
    expect(() => parseSquirrelJson({ acorns: 'nope' })).toThrow(/must have an "acorns" array/);
  });

  it('throws when an acorn entry is invalid', () => {
    expect(() => parseSquirrelJson({ acorns: [{ bad: true }] }))
      .toThrow(/acorns\[0\]/);
  });
});

// ---------------------------------------------------------------------------
// s3PathToHttps
// ---------------------------------------------------------------------------

describe('s3PathToHttps', () => {
  it('converts a standard s3:// file path', () => {
    const result = s3PathToHttps('s3://my-bucket/path/to/file.pqt', 'us-east-1');
    expect(result).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/path/to/file.pqt');
  });

  it('converts an s3:// directory path (trailing slash)', () => {
    const result = s3PathToHttps('s3://my-bucket/dir/', 'us-west-2');
    expect(result).toBe('https://my-bucket.s3.us-west-2.amazonaws.com/dir/');
  });

  it('uses the default region from constants when region is omitted', () => {
    const result = s3PathToHttps('s3://bucket/key.pqt');
    expect(result).toMatch(/\.amazonaws\.com\//);
  });

  it('throws on non-string input', () => {
    expect(() => s3PathToHttps(42)).toThrow(/must be a string/);
  });

  it('throws on an invalid (non-s3://) path', () => {
    expect(() => s3PathToHttps('https://example.com/file')).toThrow(/Invalid S3 path/);
    expect(() => s3PathToHttps('/local/path')).toThrow(/Invalid S3 path/);
  });
});

// ---------------------------------------------------------------------------
// buildParquetArg
// ---------------------------------------------------------------------------

describe('buildParquetArg', () => {
  it('returns a quoted https:// URL for a non-partitioned acorn', () => {
    const arg = buildParquetArg(METADATA_ACORN);
    expect(arg).toMatch(/^'https:\/\//);
    expect(arg).not.toContain('hive_partitioning');
    expect(arg).toContain('zs_asset_basics.pqt');
  });

  it('converts s3:// location to https:// URL', () => {
    const arg = buildParquetArg(METADATA_ACORN);
    expect(arg).toBe(`'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs_asset_basics.pqt'`);
  });

  it('returns a glob https:// URL with hive_partitioning for a partitioned acorn', () => {
    const arg = buildParquetArg(ASSET_ACORN_PARTITIONED);
    expect(arg).toContain('*.pqt');
    expect(arg).toContain('hive_partitioning=true');
    expect(arg).toContain('union_by_name=true');
    // Should not have double-slash in the glob (e.g. dir//*.pqt)
    expect(arg).not.toMatch(/[^:]\/{2}/);
  });

  it('strips trailing slash before appending glob', () => {
    const arg = buildParquetArg(ASSET_ACORN_PARTITIONED);
    expect(arg).not.toContain('//*.pqt');
  });

  it('uses https:// prefix in the glob path', () => {
    const arg = buildParquetArg(ASSET_ACORN_PARTITIONED);
    expect(arg).toMatch(/^'https:\/\//);
  });
});

// ---------------------------------------------------------------------------
// getMetadataAcorns / getAssetAcorns / getAcornByName
// ---------------------------------------------------------------------------

describe('getMetadataAcorns', () => {
  it('returns only metadata-type acorns', () => {
    const result = getMetadataAcorns(SAMPLE_SQUIRREL.acorns);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('asset_basics');
  });

  it('returns empty array when none match', () => {
    expect(getMetadataAcorns([ASSET_ACORN_PARTITIONED])).toEqual([]);
  });
});

describe('getAssetAcorns', () => {
  it('returns only asset-type acorns', () => {
    const result = getAssetAcorns(SAMPLE_SQUIRREL.acorns);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('quality_control');
  });

  it('returns empty array when none match', () => {
    expect(getAssetAcorns([METADATA_ACORN])).toEqual([]);
  });
});

describe('getAcornByName', () => {
  it('finds an acorn by name', () => {
    const result = getAcornByName(SAMPLE_SQUIRREL.acorns, 'asset_basics');
    expect(result).toBe(METADATA_ACORN);
  });

  it('returns undefined when not found', () => {
    expect(getAcornByName(SAMPLE_SQUIRREL.acorns, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRegisterSql
// ---------------------------------------------------------------------------

describe('buildRegisterSql', () => {
  it('generates SELECT * with no casts when columnCasts is empty', () => {
    const sql = buildRegisterSql(METADATA_ACORN);
    expect(sql).toMatch(/^CREATE OR REPLACE TABLE asset_basics AS SELECT \* FROM read_parquet/);
    expect(sql).not.toContain('SELECT * REPLACE(');
  });

  it('generates SELECT * REPLACE(...) when columnCasts are provided', () => {
    const sql = buildRegisterSql(METADATA_ACORN, { acquisition_start_time: 'TIMESTAMPTZ' });
    expect(sql).toContain('SELECT * REPLACE(');
    expect(sql).toContain('CAST(acquisition_start_time AS TIMESTAMPTZ) AS acquisition_start_time');
  });

  it('includes multiple REPLACE expressions when multiple casts are given', () => {
    const sql = buildRegisterSql(METADATA_ACORN, {
      acquisition_start_time: 'TIMESTAMPTZ',
      acquisition_end_time: 'TIMESTAMPTZ',
    });
    expect(sql).toContain('CAST(acquisition_start_time AS TIMESTAMPTZ) AS acquisition_start_time');
    expect(sql).toContain('CAST(acquisition_end_time AS TIMESTAMPTZ) AS acquisition_end_time');
  });

  it('includes the parquet arg for a partitioned acorn', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED);
    expect(sql).toContain('hive_partitioning=true');
    expect(sql).toContain('union_by_name=true');
    expect(sql).toContain('quality_control');
  });

  it('adds WHERE subject_id IN (...) when subjectIds are provided and acorn is partitioned by subject_id', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, ['s1', 's2']);
    expect(sql).toContain("WHERE subject_id IN ('s1', 's2')");
  });

  it('escapes single quotes in subject IDs to prevent SQL injection', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, ["O'Brien"]);
    expect(sql).toContain("'O''Brien'");
  });

  it('does not add WHERE clause when subjectIds is null', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, null);
    expect(sql).not.toContain('WHERE');
  });

  it('does not add WHERE clause when subjectIds is an empty array', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, []);
    expect(sql).not.toContain('WHERE');
  });

  it('does not add WHERE clause for metadata-type acorns even if they have a subject_id column', () => {
    // metadata acorns (e.g. asset_basics) are always loaded in full
    const sql = buildRegisterSql(METADATA_ACORN, {}, ['s1']);
    expect(sql).not.toContain('WHERE');
  });
});

// ---------------------------------------------------------------------------
// ACORN_COLUMN_CASTS
// ---------------------------------------------------------------------------

describe('ACORN_COLUMN_CASTS', () => {
  it('defines TIMESTAMPTZ casts for both asset_basics time columns', () => {
    const casts = ACORN_COLUMN_CASTS.asset_basics;
    expect(casts).toBeDefined();
    expect(casts.acquisition_start_time).toBe('TIMESTAMPTZ');
    expect(casts.acquisition_end_time).toBe('TIMESTAMPTZ');
  });
});
