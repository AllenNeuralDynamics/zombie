import { ensureTable } from '../lib/registry.js';
import { queryRows } from '../lib/arrow.js';

/** Keep the latest complete annotation for each fiber across stitched assets. */
export function selectFiberTips(rows) {
  const tips = new Map();
  for (const source of rows) {
    const row = { ...source };
    for (const axis of ['ap', 'dv', 'ml']) {
      if (typeof row[axis] === 'bigint') row[axis] = Number(row[axis]);
    }
    if (!row.fiber || ![row.ap, row.dv, row.ml].every(value =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) continue;
    const previous = tips.get(row.fiber);
    if (!previous || String(row.status_timestamp ?? '').localeCompare(String(previous.status_timestamp ?? '')) > 0) {
      tips.set(row.fiber, row);
    }
  }
  return [...tips.values()];
}

export async function loadFiberTips(coordinator, subjectId) {
  if (!coordinator || !subjectId) return [];
  await ensureTable(coordinator, 'platform_smartspim_fiber_ccf');
  const subject = String(subjectId).replace(/'/g, "''");
  return selectFiberTips(await queryRows(coordinator, `
    SELECT fiber, ap, dv, ml, status_timestamp
    FROM platform_smartspim_fiber_ccf
    WHERE subject_id = '${subject}'
    ORDER BY status_timestamp DESC NULLS LAST, name DESC
  `));
}
