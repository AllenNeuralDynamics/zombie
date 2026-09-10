/** Utilities for resolving derived assets to their raw source assets. */

function sourceNames(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean);
  return value ? [String(value)] : [];
}

function downstreamNames(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
    } catch {
      // Fall back to the legacy comma-separated representation.
    }
    return sourceNames(value);
  }
  return [];
}

function buildParents(sourceRows = []) {
  const parents = new Map();
  for (const row of sourceRows) {
    if (!row?.name) continue;
    const values = sourceNames(row.source_data);
    if (!parents.has(row.name)) parents.set(row.name, []);
    for (const value of values) {
      if (!parents.get(row.name).includes(value)) parents.get(row.name).push(value);
    }
  }
  return parents;
}

/** Return every raw root reachable from an asset, in source order. */
export function findRawAssetNames(assetName, sourceRows = []) {
  if (!assetName) return [];
  const parents = buildParents(sourceRows);
  const visit = (name, seen) => {
    if (seen.has(name)) return [name];
    const sources = parents.get(name) ?? [];
    if (!sources.length) return [name];
    const roots = [];
    for (const source of sources) {
      for (const root of visit(source, new Set([...seen, name]))) {
        if (!roots.includes(root)) roots.push(root);
      }
    }
    return roots.length ? roots : [name];
  };
  return visit(String(assetName), new Set());
}

export function findRawAssetName(assetName, sourceRows = []) {
  return findRawAssetNames(assetName, sourceRows)[0] ?? String(assetName ?? '');
}

export function assetNamesForQcRows(rows = []) {
  const names = [];
  for (const row of rows) {
    for (const name of [row.asset_name, ...downstreamNames(row.downstream_asset_names)]) {
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}
