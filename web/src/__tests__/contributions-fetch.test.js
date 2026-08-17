import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchContributions } from '../contributions/fetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchContributions', () => {
  it('retries once after a network failure', async () => {
    const response = { ok: true };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Network error'))
      .mockResolvedValueOnce(response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchContributions('/metadata-viz/contributions/get')).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});