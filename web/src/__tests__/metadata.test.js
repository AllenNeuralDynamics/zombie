/**
 * metadata.test.js — Unit tests for pure functions in metadata.js.
 *
 * DB-dependent functions (fetchAndRegisterMetadata, registerAcornTable,
 * dropAcornTable) are NOT tested here — they require a live DuckDB-WASM
 * coordinator.  Integration tests for those belong in a future Playwright /
 * browser-test suite.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  validateAcorn,
  parseCacheRegistryJson,
  s3PathToHttps,
  buildParquetArg,
  buildRegisterSql,
  quoteIdentifier,
  ACORN_COLUMN_CASTS,
  getMetadataAcorns,
  getAssetAcorns,
  getAcornByName,
  registerEagerTables,
  RequiredTablesError,
  categorizeTableError,
  describeTableError,
  sanitizeErrorMessage,
} from '../lib/metadata.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const METADATA_ACORN = {
  name: 'asset_basics',
  location: 's3://allen-data-views/data-asset-cache/zs-v0.28.1/asset_basics.pqt',
  partitioned: false,
  partition_key: null,
  type: 'metadata',
  columns: ['_id', 'project_name', 'subject_id'],
};

const ASSET_ACORN_PARTITIONED = {
  name: 'quality_control',
  location: 's3://allen-data-views/data-asset-cache/zs-v0.28.1/qc/',
  partitioned: true,
  partition_key: 'subject_id',
  type: 'asset',
  columns: ['name', 'stage', 'value'],
};

const SAMPLE_SQUIRREL = {
  tables: [METADATA_ACORN, ASSET_ACORN_PARTITIONED],
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

  it('does not throw when type is an unrecognised value (e.g. "platform")', () => {
    // Unknown types are valid — pages that need them use them directly.
    expect(() => validateAcorn({ ...METADATA_ACORN, type: 'platform' })).not.toThrow();
    expect(() => validateAcorn({ ...METADATA_ACORN, type: 'unknown' })).not.toThrow();
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
// parseCacheRegistryJson
// ---------------------------------------------------------------------------

describe('parseCacheRegistryJson', () => {
  it('returns the same object when valid', () => {
    const result = parseCacheRegistryJson({ ...SAMPLE_SQUIRREL });
    expect(result.acorns).toHaveLength(2);
  });

  it('throws when input is not an object', () => {
    expect(() => parseCacheRegistryJson('string')).toThrow(/must be a JSON object/);
    expect(() => parseCacheRegistryJson(null)).toThrow(/must be a JSON object/);
  });

  it('throws when "tables" key is missing', () => {
    expect(() => parseCacheRegistryJson({})).toThrow(/must have a "tables" array/);
  });

  it('throws when "tables" is not an array', () => {
    expect(() => parseCacheRegistryJson({ tables: 'nope' })).toThrow(/must have a "tables" array/);
  });

  it('throws when an entry is invalid', () => {
    expect(() => parseCacheRegistryJson({ tables: [{ bad: true }] }))
      .toThrow(/acorns\[0\]/);
  });

  it('passes through entries with unrecognised types without crashing', () => {
    // Regression: cache_registry.json added type "platform" which crashed the app.
    // Unknown-type acorns must be preserved so platform pages can use them.
    const platformAcorn = { ...METADATA_ACORN, name: 'plat', type: 'platform' };
    const result = parseCacheRegistryJson({ tables: [METADATA_ACORN, platformAcorn] });
    expect(result.acorns).toHaveLength(2);
    expect(result.acorns.find((a) => a.name === 'plat')).toBeDefined();
  });

  it('keeps all entries when all types are known', () => {
    const result = parseCacheRegistryJson({ ...SAMPLE_SQUIRREL });
    expect(result.acorns).toHaveLength(2);
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
    expect(arg).toContain('asset_basics.pqt');
  });

  it('converts s3:// location to https:// URL', () => {
    const arg = buildParquetArg(METADATA_ACORN);
    expect(arg).toBe(`'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs-v0.28.1/asset_basics.pqt'`);
  });

  it('returns a glob https:// URL with hive_partitioning for a partitioned acorn', () => {
    const arg = buildParquetArg(ASSET_ACORN_PARTITIONED);
    expect(arg).toContain('**');
    expect(arg).toContain('hive_partitioning=true');
    expect(arg).toContain('union_by_name=true');
    // Should not have double-slash in the glob (e.g. dir//**)
    expect(arg).not.toMatch(/[^:]\/{2}/);
  });

  it('strips trailing slash before appending glob', () => {
    const arg = buildParquetArg(ASSET_ACORN_PARTITIONED);
    expect(arg).not.toContain('//**');
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
    const result = getMetadataAcorns(SAMPLE_SQUIRREL.tables);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('asset_basics');
  });

  it('returns empty array when none match', () => {
    expect(getMetadataAcorns([ASSET_ACORN_PARTITIONED])).toEqual([]);
  });
});

describe('getAssetAcorns', () => {
  it('returns only asset-type acorns', () => {
    const result = getAssetAcorns(SAMPLE_SQUIRREL.tables);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('quality_control');
  });

  it('returns empty array when none match', () => {
    expect(getAssetAcorns([METADATA_ACORN])).toEqual([]);
  });
});

describe('getAcornByName', () => {
  it('finds an acorn by name', () => {
    const result = getAcornByName(SAMPLE_SQUIRREL.tables, 'asset_basics');
    expect(result).toBe(METADATA_ACORN);
  });

  it('returns undefined when not found', () => {
    expect(getAcornByName(SAMPLE_SQUIRREL.tables, 'nonexistent')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildRegisterSql
// ---------------------------------------------------------------------------

describe('buildRegisterSql', () => {
  it('generates SELECT * with no casts when columnCasts is empty', () => {
    const sql = buildRegisterSql(METADATA_ACORN);
    expect(sql).toMatch(/^CREATE OR REPLACE TABLE "asset_basics" AS SELECT \* FROM read_parquet/);
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

  it('loads no rows when subjectIds is an empty array', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, []);
    expect(sql).toContain('WHERE FALSE');
  });

  it('registers into a validated target name', () => {
    const sql = buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, ['s1'], 'quality_control__scope_1234');
    expect(sql).toMatch(/^CREATE OR REPLACE TABLE "quality_control__scope_1234"/);
  });

  it('rejects invalid target identifiers', () => {
    expect(() => buildRegisterSql(ASSET_ACORN_PARTITIONED, {}, ['s1'], 'bad; DROP TABLE x'))
      .toThrow(/Invalid SQL identifier/);
    expect(() => quoteIdentifier('also-bad')).toThrow(/Invalid SQL identifier/);
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

// ---------------------------------------------------------------------------
// registerEagerTables / RequiredTablesError
// ---------------------------------------------------------------------------

function mockCoordinator() {
  return { exec: vi.fn().mockResolvedValue(undefined) };
}

const OTHER_METADATA_ACORN = {
  name: 'unique_project_names',
  location: 's3://allen-data-views/data-asset-cache/zs-v0.28.1/unique_project_names.pqt',
  partitioned: false,
  partition_key: null,
  type: 'metadata',
  columns: ['project_name'],
};

describe('registerEagerTables', () => {
  it('registers all required tables successfully', async () => {
    const coord = mockCoordinator();
    const metadata = { acorns: [METADATA_ACORN] };
    const result = await registerEagerTables(coord, metadata, { requiredTables: ['asset_basics'] });
    expect(result.registered).toEqual(['asset_basics']);
    expect(result.failures).toEqual([]);
    expect(coord.exec).toHaveBeenCalledTimes(1);
  });

  it('throws RequiredTablesError when a required table fails', async () => {
    const coord = mockCoordinator();
    coord.exec.mockRejectedValue(new Error('boom'));
    const metadata = { acorns: [METADATA_ACORN] };
    await expect(registerEagerTables(coord, metadata, { requiredTables: ['asset_basics'] }))
      .rejects.toBeInstanceOf(RequiredTablesError);
  });

  it('preserves every failed required table name in the aggregate error', async () => {
    const coord = mockCoordinator();
    coord.exec.mockRejectedValue(new Error('boom'));
    const metadata = { acorns: [METADATA_ACORN, OTHER_METADATA_ACORN] };
    try {
      await registerEagerTables(coord, metadata, { requiredTables: ['asset_basics', 'unique_project_names'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RequiredTablesError);
      expect(err.requiredFailures.map((f) => f.table).sort()).toEqual(['asset_basics', 'unique_project_names']);
      // Both registrations were attempted even though both failed.
      expect(coord.exec).toHaveBeenCalledTimes(2);
    }
  });

  it('does not block startup when only an optional table fails', async () => {
    const coord = mockCoordinator();
    coord.exec.mockImplementation((sql) => {
      if (sql.includes('unique_project_names')) return Promise.reject(new Error('boom'));
      return Promise.resolve();
    });
    const metadata = { acorns: [METADATA_ACORN, OTHER_METADATA_ACORN] };
    const result = await registerEagerTables(coord, metadata, {
      requiredTables: ['asset_basics'],
      optionalTables: ['unique_project_names'],
    });
    expect(result.registered).toEqual(['asset_basics']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ table: 'unique_project_names', required: false });
  });

  it('rejects a table listed as both required and optional', async () => {
    const coord = mockCoordinator();
    const metadata = { acorns: [METADATA_ACORN] };
    await expect(registerEagerTables(coord, metadata, {
      requiredTables: ['asset_basics'],
      optionalTables: ['asset_basics'],
    })).rejects.toThrow(/both required and optional/);
  });

  it('rejects an unknown table name', async () => {
    const coord = mockCoordinator();
    const metadata = { acorns: [METADATA_ACORN] };
    await expect(registerEagerTables(coord, metadata, { requiredTables: ['does_not_exist'] }))
      .rejects.toThrow(/Unknown eager table/);
  });

  it('can be retried after a failure once the underlying issue is fixed', async () => {
    const coord = mockCoordinator();
    coord.exec.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined);
    const metadata = { acorns: [METADATA_ACORN] };
    await expect(registerEagerTables(coord, metadata, { requiredTables: ['asset_basics'] }))
      .rejects.toBeInstanceOf(RequiredTablesError);
    const result = await registerEagerTables(coord, metadata, { requiredTables: ['asset_basics'] });
    expect(result.registered).toEqual(['asset_basics']);
  });
});

describe('categorizeTableError / describeTableError', () => {
  it('categorizes network/CORS failures', () => {
    expect(categorizeTableError(new Error('Failed to fetch'))).toBe('network');
    expect(categorizeTableError(new Error('CORS request did not succeed'))).toBe('network');
  });

  it('categorizes registry failures', () => {
    expect(categorizeTableError(new Error('Unknown acorn: "foo"'))).toBe('registry');
  });

  it('categorizes parquet failures', () => {
    expect(categorizeTableError(new Error('404 Not Found for file.pqt'))).toBe('parquet');
  });

  it('categorizes duckdb/query failures', () => {
    expect(categorizeTableError(new Error('Binder Error: syntax error'))).toBe('query');
  });

  it('falls back to unknown for unrecognised messages', () => {
    expect(categorizeTableError(new Error('something weird happened'))).toBe('unknown');
  });

  it('describeTableError returns a non-empty safe string for every category', () => {
    for (const msg of ['Failed to fetch', 'Unknown acorn', '404', 'Binder Error', 'out of memory', 'weird']) {
      expect(describeTableError(new Error(msg))).toMatch(/\S/);
    }
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts query strings from URLs', () => {
    const msg = 'Failed to fetch https://bucket.s3.amazonaws.com/file.pqt?X-Amz-Signature=abc123';
    expect(sanitizeErrorMessage(msg)).not.toContain('abc123');
    expect(sanitizeErrorMessage(msg)).toContain('[redacted]');
  });

  it('returns an empty string for falsy input', () => {
    expect(sanitizeErrorMessage(null)).toBe('');
    expect(sanitizeErrorMessage(undefined)).toBe('');
  });

  it('leaves plain messages without URLs unchanged', () => {
    expect(sanitizeErrorMessage('plain error message')).toBe('plain error message');
  });
});
