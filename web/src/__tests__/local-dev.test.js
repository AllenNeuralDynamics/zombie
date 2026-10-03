import { describe, expect, it } from 'vitest';
import { isLocalDevelopment } from '../lib/local-dev.js';

describe('isLocalDevelopment', () => {
  it.each(['localhost', '127.0.0.1', '::1', '[::1]', 'zombie.localhost'])(
    'enables local mode for %s only in a dev build',
    (hostname) => {
      expect(isLocalDevelopment({ hostname, devMode: true })).toBe(true);
      expect(isLocalDevelopment({ hostname, devMode: false })).toBe(false);
    },
  );

  it('keeps local mode off on deployed hostnames', () => {
    expect(isLocalDevelopment({ hostname: 'data.allenneuraldynamics.org', devMode: true }))
      .toBe(false);
  });
});
