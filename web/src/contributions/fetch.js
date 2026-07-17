const REQUEST_TIMEOUT_MS = 7_000;
const MAX_ATTEMPTS = 2;

/**
 * Fetch a Contributions API resource with one retry for network failures or a
 * request that never receives a response.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export async function fetchContributions(url, options = {}) {
  let lastError;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      lastError = timedOut
        ? new Error('The contributions service did not respond in time.')
        : error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}