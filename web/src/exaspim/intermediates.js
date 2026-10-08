import { ensureTable, getAcorn } from '../lib/registry.js';
import { queryRows } from '../lib/arrow.js';
import { escHtml, formatDatetimeRaw } from '../lib/utils.js';
import { renderStorageLink } from '../assets/links.js';

const TABLE = 'platform_exaspim_intermediates';
const FOLDERS = [
  ['flatfield_present', 'flatfield_correction/SPIM.ome.zarr/'],
  ['denoised_present', 'denoised/SPIM.ome.zarr/'],
];

export function createIntermediatesLoader(coord) {
  let promise = null;
  return () => {
    if (!promise) {
      promise = (async () => {
        if (!getAcorn(TABLE)) throw new Error('Intermediate folder cache is unavailable.');
        await ensureTable(coord, TABLE);
        const rows = await queryRows(coord,
          `SELECT raw_name, name, location, CAST(checked_at AS VARCHAR) AS checked_at, flatfield_present, denoised_present,
                  status, error_code
           FROM ${TABLE}
           ORDER BY raw_name, name NULLS LAST`,
        );
        const byRaw = new Map();
        for (const row of rows) {
          if (!byRaw.has(row.raw_name)) byRaw.set(row.raw_name, []);
          byRaw.get(row.raw_name).push(row);
        }
        return byRaw;
      })().catch((error) => {
        promise = null;
        throw error;
      });
    }
    return promise;
  };
}

export function folderStatus(value) {
  if (value === true) return 'Present';
  if (value === false) return 'Deleted / absent';
  return 'Unknown';
}

export function intermediatesDeletedStatus(rows = []) {
  if (!rows.length) return 'Unknown';
  const processed = rows.filter((row) => row.status !== 'no_processed');
  if (!processed.length) return 'No processed assets';
  if (processed.some((row) => FOLDERS.some(([key]) => row[key] === true))) return 'No';
  if (processed.some((row) => FOLDERS.some(([key]) => row[key] !== false))) return 'Unknown';
  return 'Yes';
}

export function renderIntermediateDetails(rows = []) {
  if (!rows.length) return '<p>No intermediate folder checks are available for this acquisition.</p>';
  return rows.map((row) => {
    if (row.status === 'no_processed') return '<p>No processed asset was found for this acquisition.</p>';
    const checked = row.checked_at == null ? '' : formatDatetimeRaw(row.checked_at);
    const issue = row.status === 's3_error' ? 'Some S3 checks failed.'
      : row.status === 'invalid_location' ? 'The asset has no valid S3 location.' : '';
    const folders = FOLDERS.map(([key, path]) => {
      const status = folderStatus(row[key]);
      return `<tr><td><code>${path}</code></td><td class="exaspim-folder-status">${status}</td></tr>`;
    }).join('');
    return `<section class="exaspim-intermediate-asset">
      <div class="exaspim-intermediate-heading"><span>${escHtml(row.name ?? 'Unknown asset')}</span>${renderStorageLink(row.location)}</div>
      ${checked ? `<p class="exaspim-intermediate-checked">Checked ${escHtml(checked)}</p>` : ''}
      ${issue ? `<p class="error">${issue}</p>` : ''}
      <table class="exaspim-folder-table"><thead><tr><th>Intermediate folder</th><th>Status</th></tr></thead><tbody>${folders}</tbody></table>
    </section>`;
  }).join('');
}
