import { escHtml } from '../lib/utils.js';

/**
 * assets/links.js — Pure URL builders for asset external links.
 *
 * Extracted from assets/view.js so that lightweight consumers (subject details,
 * record viewer, platform pages) can build asset links WITHOUT importing the
 * full assets view, which pulls in Apache Arrow, Observable Plot, and the query
 * builder (~400 KB). These functions are pure string builders.
 *
 * @module
 */

/**
 * Convert an S3 URI to an AWS console URL.
 *
 * s3://bucket/key/path  →  https://s3.console.aws.amazon.com/s3/buckets/bucket?prefix=key/path/
 *
 * @param {string|null} location - e.g. "s3://aind-data/my-project/asset/"
 * @returns {string|null}
 */
export function buildS3ConsoleUrl(location) {
  if (!location || !location.startsWith('s3://')) return null;
  const withoutScheme = location.slice(5); // drop "s3://"
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) {
    return `https://s3.console.aws.amazon.com/s3/buckets/${withoutScheme}`;
  }
  const bucket = withoutScheme.slice(0, slashIdx);
  const prefix = withoutScheme.slice(slashIdx + 1);
  // Ensure trailing slash so the console shows the folder contents.
  const trailingPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?prefix=${trailingPrefix}`;
}

/** Build the browsing destination and access state for an asset location. */
export function buildStorageLink(location) {
  const match = typeof location === 'string' && location.match(/^s3:\/\/([^/]+)(?:\/(.*))?$/);
  if (!match) return null;
  const [, bucket, key = ''] = match;
  if (bucket === 'aind-open-data') {
    const path = key.split('/').map(encodeURIComponent).join('/');
    return {
      href: `https://open.quiltdata.com/b/${bucket}/${path ? `tree/${path.endsWith('/') ? path : `${path}/`}` : ''}`,
      label: 'S3',
      private: false,
    };
  }
  return { href: buildS3ConsoleUrl(location), label: 'S3', private: true };
}

/** Render a storage button with the private bucket hover tooltip when applicable. */
export function renderStorageLink(location, label = null) {
  const link = buildStorageLink(location);
  if (!link) return '';
  const attrs = link.private ? ' class="storage-link-private" title="This bucket is private"' : '';
  return `<a href="${escHtml(link.href)}" target="_blank" rel="noopener noreferrer"${attrs}>${escHtml(label ?? link.label)}</a>`;
}

/**
 * Build the AIND QC portal URL for an asset.
 *
 * @param {string|null} name - Asset name column value.
 * @returns {string|null}
 */
export function buildQcLink(name) {
  if (!name) return null;
  return `/quality_control?name=${encodeURIComponent(name)}`;
}

/**
 * Build the AIND metadata portal URL for an asset.
 *
 * @param {string|null} name - Asset name column value.
 * @returns {string|null}
 */
export function buildMetadataLink(name) {
  if (!name) return null;
  return `/record?name=${encodeURIComponent(name)}`;
}

/**
 * Build the Code Ocean data-asset URL.
 *
 * @param {string|null} codeOcean - Data-asset ID or null.
 * @returns {string|null}
 */
export function buildCoLink(codeOcean) {
  if (!codeOcean) return null;
  return `https://codeocean.allenneuraldynamics.org/data-assets/${codeOcean}`;
}
