/**
 * lib/platform-summary.js — Shared summary banner for platform pages.
 *
 * Creates a one-line stat row: "N Assets (M do not upgrade)" where M is a
 * download link for the failed-upgrade rows from metadata_upgrade.
 */

import { ensureTable } from './registry.js';
import { queryRows } from './arrow.js';

function ensureUpgradeTable(coord) {
  return ensureTable(coord, 'metadata_upgrade');
}

/**
 * Build and return a summary banner element.  The element is returned
 * immediately (showing "Loading…") and populated asynchronously.
 *
 * @param {object} coord        Mosaic coordinator (DuckDB-WASM)
 * @param {object} opts
 * @param {string} opts.platformTableName  Already-registered DuckDB table
 * @param {string} opts.assetNameCol       Column holding asset names in that table
 */
export function createPlatformSummaryBanner(coord, { platformTableName, assetNameCol }) {
  const banner = document.createElement('div');
  banner.className = 'platform-summary-banner';

  const heading = document.createElement('h3');
  heading.className = 'platform-summary-heading';
  heading.textContent = 'Platform overview';
  banner.appendChild(heading);

  const stats = document.createElement('div');
  stats.className = 'platform-summary-stats';
  stats.textContent = 'Loading summary…';
  banner.appendChild(stats);

  ensureUpgradeTable(coord)
    .then(() => coord.query(
      `SELECT
         (SELECT COUNT(DISTINCT ${assetNameCol}) FROM ${platformTableName}) AS total_assets,
         (SELECT COUNT(*) FROM metadata_upgrade
          WHERE status = 'failed'
            AND name IN (SELECT DISTINCT ${assetNameCol} FROM ${platformTableName})) AS failed_assets`,
    ))
    .then((result) => {
      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      const row = rows[0] ?? {};
      const total = Number(row.total_assets ?? 0);
      const failed = Number(row.failed_assets ?? 0);

      stats.textContent = '';

      const countSpan = document.createElement('span');
      countSpan.className = 'platform-summary-count';
      countSpan.textContent = `${total.toLocaleString()} Assets`;
      stats.appendChild(countSpan);

      if (failed > 0) {
        stats.appendChild(document.createTextNode(' ('));

        const link = document.createElement('a');
        link.className = 'platform-summary-failed-link';
        link.href = '#';
        link.textContent = `${failed.toLocaleString()} do not upgrade`;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          downloadFailedUpgrades(coord, platformTableName, assetNameCol);
        });
        stats.appendChild(link);

        stats.appendChild(document.createTextNode(')'));
      }
    })
    .catch((err) => {
      console.error('[PlatformSummary] summary query failed:', err?.message ?? err, err);
      stats.textContent = `Summary unavailable: ${err?.message ?? err}`;
    });

  return banner;
}

function downloadFailedUpgrades(coord, platformTableName, assetNameCol) {
  coord.query(
    `SELECT * FROM metadata_upgrade
     WHERE status = 'failed'
       AND name IN (SELECT DISTINCT ${assetNameCol} FROM ${platformTableName})`,
  )
    .then((result) => {
      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      if (rows.length === 0) return;

      const cols = Object.keys(rows[0]);
      const csvLines = [
        cols.join(','),
        ...rows.map((r) => cols.map((c) => {
          const v = r[c] ?? '';
          const s = String(v);
          return s.includes(',') || s.includes('"') || s.includes('\n')
            ? `"${s.replace(/"/g, '""')}"` : s;
        }).join(',')),
      ];
      const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${platformTableName}_failed_upgrades.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch((err) => console.error('[PlatformSummary] download failed:', err));
}
