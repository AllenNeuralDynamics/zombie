/**
 * video-gate.js — Lightweight password gate for video playback.
 *
 * This is a *deterrent*, not real security: it hides the video UI behind a
 * shared password so random people can't casually browse the behavior videos.
 * The underlying media URLs are still public S3 objects — anyone who reads the
 * network traffic can reach them. Don't rely on this to protect anything that
 * genuinely must stay private; for that the bytes have to be proxied/presigned
 * server-side.
 *
 * Only the SHA-256 digest of `${SALT}:${password}` is stored in source — never
 * the plaintext. A correct entry is remembered in a cookie so the user is asked
 * at most once per browser (persists across sessions until the cookie expires).
 *
 * Usage:
 *   import { withVideoGate, isVideoUnlocked } from '../lib/video-gate.js';
 *   // Defer building the (video-bearing) element until unlocked:
 *   parent.appendChild(withVideoGate(() => buildVideoPanel(...)));
 */

// SHA-256 of `${SALT}:${password}`. To change the password, recompute with:
//   node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("aind-video-gate-v1:"+process.argv[1]).digest("hex"))' 'NEW_PASSWORD'
const SALT = 'aind-video-gate-v1';
const PASSWORD_SHA256 =
  'ce069fa6f9e0a38914aac784f803f18792da2dcfa4a50b7d29bc3e451fb3cab8';

const COOKIE_NAME = 'aind_video_unlocked';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 1 year, in seconds

const INTERNAL_NETWORK_URL = 'http://aind-metadata-service';
const INTERNAL_NETWORK_TIMEOUT_MS = 3000;

let _internalNetworkPromise = null;
async function isOnInternalNetwork() {
  if (_internalNetworkPromise === null) {
    _internalNetworkPromise = fetch(INTERNAL_NETWORK_URL, {
      mode: 'no-cors',
      signal: AbortSignal.timeout(INTERNAL_NETWORK_TIMEOUT_MS),
    }).then(() => true).catch(() => false);
  }
  return _internalNetworkPromise;
}

function readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

/**
 * Has the gate already been satisfied? We store the password digest itself in
 * the cookie and re-verify it against the expected digest on load, so a stale
 * cookie from a previous password automatically stops working.
 */
export function isVideoUnlocked() {
  try {
    return readCookie(COOKIE_NAME) === PASSWORD_SHA256;
  } catch {
    return false;
  }
}

function markUnlocked() {
  try {
    document.cookie =
      `${COOKIE_NAME}=${encodeURIComponent(PASSWORD_SHA256)}; ` +
      `max-age=${COOKIE_MAX_AGE}; path=/; SameSite=Lax`;
  } catch { /* ignore */ }
}

/** Compute the lowercase hex SHA-256 of an arbitrary string. */
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Check a candidate password against the stored digest. */
export async function checkPassword(candidate) {
  if (!candidate) return false;
  const hex = await sha256Hex(`${SALT}:${candidate}`);
  return hex === PASSWORD_SHA256;
}

/**
 * Build a small inline password prompt. Calls `onUnlock()` once the correct
 * password is entered (and remembers it for the session).
 *
 * @param {() => void} onUnlock
 * @returns {HTMLElement}
 */
function buildPrompt(onUnlock) {
  const wrap = document.createElement('div');
  wrap.className = 'video-gate';
  wrap.innerHTML = `
    <p class="video-gate-msg">🔒 Enter the password to view videos.</p>
    <form class="video-gate-form">
      <input type="password" class="video-gate-input"
             placeholder="Password" autocomplete="current-password"
             aria-label="Video password" />
      <button type="submit" class="video-gate-submit">Unlock</button>
    </form>
    <p class="video-gate-error" hidden>Incorrect password.</p>
  `;

  const form  = wrap.querySelector('.video-gate-form');
  const input = wrap.querySelector('.video-gate-input');
  const error = wrap.querySelector('.video-gate-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    const ok = await checkPassword(input.value);
    if (ok) {
      markUnlocked();
      onUnlock();
    } else {
      error.hidden = false;
      input.value = '';
      input.focus();
    }
  });

  return wrap;
}

/**
 * Wrap video-bearing content behind the password gate.
 *
 * Returns a container that either renders `build()` immediately (if already
 * unlocked this session) or shows a password prompt and renders `build()` once
 * the gate is satisfied. `build()` is only invoked when unlocked, so callers
 * can defer creating <video> elements (and their network requests) until then.
 *
 * @param {() => HTMLElement} build - Factory for the gated content.
 * @returns {HTMLElement}
 */
export function withVideoGate(build) {
  const container = document.createElement('div');
  container.className = 'video-gate-container';

  const render = () => {
    container.innerHTML = '';
    container.appendChild(build());
  };

  if (isVideoUnlocked()) {
    render();
    return container;
  }

  const checking = document.createElement('p');
  checking.className = 'video-gate-msg';
  checking.textContent = 'Checking network…';
  container.appendChild(checking);

  isOnInternalNetwork().then((internal) => {
    if (internal || isVideoUnlocked()) {
      render();
    } else {
      container.innerHTML = '';
      container.appendChild(buildPrompt(render));
    }
  });

  return container;
}
