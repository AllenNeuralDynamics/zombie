import { describe, expect, it } from 'vitest';
import { buildStorageLink, renderStorageLink } from '../assets/links.js';
import { renderAssetRow } from '../assets/view.js';

describe('storage links', () => {
  it('links public assets to Quilt with encoded path segments', () => {
    expect(buildStorageLink('s3://aind-open-data/asset name/part#1')).toEqual({
      href: 'https://open.quiltdata.com/b/aind-open-data/tree/asset%20name/part%231/',
      label: 'S3',
      private: false,
    });
    expect(buildStorageLink('s3://aind-open-data/asset/').href).toBe(
      'https://open.quiltdata.com/b/aind-open-data/tree/asset/',
    );
    expect(buildStorageLink('s3://aind-open-data').href).toBe(
      'https://open.quiltdata.com/b/aind-open-data/',
    );
  });

  it('keeps private assets in the AWS console with grey styling and a tooltip', () => {
    const html = renderStorageLink('s3://aind-data/asset');
    expect(html).toContain('s3.console.aws.amazon.com');
    expect(html).toContain('class="storage-link-private"');
    expect(html).toContain('title="This bucket is private"');
    expect(html).toContain('>S3</a>');
  });

  it('renders public and private buttons in asset rows', () => {
    const publicRow = renderAssetRow({ location: 's3://aind-open-data/asset' }, ['links']);
    expect(publicRow).toContain('open.quiltdata.com');
    expect(publicRow).toContain('>S3</a>');
    expect(publicRow).not.toContain('storage-link-private');
    expect(publicRow).not.toContain('title=');
    const privateRow = renderAssetRow({ location: 's3://aind-data/asset' }, ['links']);
    expect(privateRow).toContain('storage-link-private');
    expect(privateRow).toContain('title="This bucket is private"');
  });

  it('omits invalid locations and escapes custom labels', () => {
    for (const location of [null, undefined, '', 'https://example.com', 's3:///asset']) {
      expect(buildStorageLink(location)).toBeNull();
      expect(renderStorageLink(location)).toBe('');
    }
    expect(renderStorageLink('s3://aind-open-data/asset', '<asset>')).toContain('&lt;asset&gt;');
  });
});
