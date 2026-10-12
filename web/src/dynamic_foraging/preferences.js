const SPOUT_BIAS_KEY = 'df-show-spout-bias';

export function getShowSpoutBias() {
  try {
    return localStorage.getItem(SPOUT_BIAS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setShowSpoutBias(show) {
  try {
    localStorage.setItem(SPOUT_BIAS_KEY, String(show));
  } catch { /* Storage may be unavailable. */ }
}
