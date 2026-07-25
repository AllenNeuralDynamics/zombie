/**
 * table-load-error.test.js — Unit tests for the shared table-load error DOM
 * renderers in lib/table-load-error.js.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildTableLoadErrorBox,
  buildTableLoadWarningBox,
  buildInlineTableError,
} from '../lib/table-load-error.js';
import { ISSUE_TRACKER_URL } from '../constants.js';

const FAILURE = {
  table: 'asset_basics',
  required: true,
  phase: 'register',
  message: 'Failed to fetch https://bucket.s3.amazonaws.com/file.pqt?X-Amz-Signature=secret123',
  cause: new Error('Failed to fetch'),
};

describe('buildTableLoadErrorBox', () => {
  it('shows the failed table name and a safe description', () => {
    const box = buildTableLoadErrorBox({ failures: [FAILURE], version: 'bdc-v0.37' });
    expect(box.textContent).toContain('asset_basics');
    expect(box.textContent).toMatch(/could not be loaded|failed to load/i);
  });

  it('includes the exact required issue-tracker URL', () => {
    const box = buildTableLoadErrorBox({ failures: [FAILURE] });
    const link = box.querySelector('a');
    expect(link.href).toBe(ISSUE_TRACKER_URL);
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('invokes the retry callback exactly once per click', () => {
    const onRetry = vi.fn();
    const box = buildTableLoadErrorBox({ failures: [FAILURE], onRetry });
    const btn = box.querySelector('.table-load-error-retry');
    btn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never renders dynamic failure text as HTML', () => {
    const maliciousFailure = {
      table: '<img src=x onerror=alert(1)>',
      required: true,
      message: '<script>alert(1)</script>',
      cause: new Error('<script>alert(1)</script>'),
    };
    const box = buildTableLoadErrorBox({ failures: [maliciousFailure] });
    expect(box.querySelector('img')).toBeNull();
    expect(box.querySelector('script')).toBeNull();
    expect(box.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('redacts sensitive query-string values from the diagnostics section', () => {
    const box = buildTableLoadErrorBox({ failures: [FAILURE], version: 'bdc-v0.37' });
    const diagnostics = box.querySelector('.table-load-error-diagnostics');
    expect(diagnostics.textContent).not.toContain('secret123');
    expect(diagnostics.textContent).toContain('bdc-v0.37');
  });
});

describe('buildTableLoadWarningBox', () => {
  it('names the failed optional tables', () => {
    const box = buildTableLoadWarningBox({ failures: [{ table: 'quality_control', message: 'boom' }] });
    expect(box.textContent).toContain('quality_control');
  });

  it('removes itself from the DOM when dismissed', () => {
    const box = buildTableLoadWarningBox({ failures: [{ table: 'quality_control', message: 'boom' }] });
    document.body.appendChild(box);
    box.querySelector('.table-load-warning-dismiss').click();
    expect(document.body.contains(box)).toBe(false);
  });
});

describe('buildInlineTableError', () => {
  it('names the failed table and offers retry', () => {
    const onRetry = vi.fn();
    const box = buildInlineTableError({ table: 'platform_fib', cause: new Error('404'), onRetry });
    expect(box.textContent).toContain('platform_fib');
    box.querySelector('button').click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
