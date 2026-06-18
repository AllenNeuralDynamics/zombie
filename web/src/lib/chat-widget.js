/**
 * lib/chat-widget.js — Floating "a//y" chat widget.
 *
 * Mounts a Clippy-style hover widget in the bottom-right corner of the page.
 * Minimised: a small tab with a ^ arrow. Maximised: a chat panel with an
 * Allen-Institute "@" mascot peeking above, complete with googly eyes that
 * blink occasionally.
 *
 * Calls the metadata-portal /chat endpoint:
 *   POST https://metadata-portal.allenneuraldynamics.org/chat
 *   { message: string, history: [{role, content}, ...] }
 */

const CHAT_ENDPOINT = 'https://metadata-portal.allenneuraldynamics.org/chat';
const GREETING = "Hi I'm a//y, what can I do for you?";
const MAX_HISTORY_TURNS = 20;
const STORAGE_KEY = 'ally-chat-state';

/**
 * Mount the chat widget into `parent` (defaults to document.body).
 *
 * @param {HTMLElement} [parent=document.body]
 * @returns {{ root: HTMLElement, destroy: () => void }}
 */
export function mountChatWidget(parent = document.body) {
  const root = document.createElement('div');
  root.className = 'cw';
  root.setAttribute('data-state', loadInitialState());
  root.innerHTML = `
    <div class="cw-open">
      <div class="cw-mascot" aria-hidden="true">
        <div class="cw-mascot-logo"></div>
        <div class="cw-eye cw-eye--left"><div class="cw-pupil"></div></div>
        <div class="cw-eye cw-eye--right"><div class="cw-pupil"></div></div>
      </div>
      <div class="cw-panel" role="dialog" aria-label="a//y chat">
        <div class="cw-header">
          <span class="cw-title">a//y</span>
          <button type="button" class="cw-collapse" aria-label="Minimize chat" title="Minimize">
            <span class="cw-caret">^</span>
          </button>
        </div>
        <div class="cw-messages" role="log" aria-live="polite"></div>
        <form class="cw-input" autocomplete="off">
          <textarea
            class="cw-textarea"
            rows="1"
            placeholder="Ask a question about our data"
            maxlength="4096"
            aria-label="Chat message"
          ></textarea>
          <button type="submit" class="cw-send" aria-label="Send">Send</button>
        </form>
      </div>
    </div>
    <button type="button" class="cw-tab" aria-label="Open chat">
      <span class="cw-tab-label">a//y</span>
      <span class="cw-caret">^</span>
    </button>
  `;
  parent.appendChild(root);

  const messagesEl = root.querySelector('.cw-messages');
  const formEl = root.querySelector('.cw-input');
  const textareaEl = root.querySelector('.cw-textarea');
  const sendBtn = root.querySelector('.cw-send');
  const collapseBtn = root.querySelector('.cw-collapse');
  const tabBtn = root.querySelector('.cw-tab');
  const leftEye = root.querySelector('.cw-eye--left');
  const rightEye = root.querySelector('.cw-eye--right');
  const logoEl = root.querySelector('.cw-mascot-logo');

  /** Conversation history sent back to the API. */
  const history = [];

  // Initial greeting (display only — not added to history).
  appendMessage(messagesEl, 'assistant', GREETING);

  // ----- Expand / collapse -----
  collapseBtn.addEventListener('click', () => setState(root, 'closed'));
  tabBtn.addEventListener('click', () => {
    setState(root, 'open');
    textareaEl.focus();
  });

  // ----- Send message -----
  formEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submit();
  });

  textareaEl.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  textareaEl.addEventListener('input', () => autosize(textareaEl));

  async function submit() {
    const text = textareaEl.value.trim();
    if (!text || sendBtn.disabled) return;
    textareaEl.value = '';
    autosize(textareaEl);

    appendMessage(messagesEl, 'user', text);
    const typingEl = appendTyping(messagesEl);
    setBusy(true);

    try {
      const reply = await sendChat(text, history);
      typingEl.remove();
      appendMessage(messagesEl, 'assistant', reply);
      history.push({ role: 'user', content: text });
      history.push({ role: 'assistant', content: reply });
      // Trim to last MAX_HISTORY_TURNS messages (each "turn" = 1 message).
      while (history.length > MAX_HISTORY_TURNS) history.shift();
    } catch (err) {
      typingEl.remove();
      appendMessage(
        messagesEl,
        'assistant',
        `Sorry — I couldn't reach the chat service. ${err?.message ?? err}`,
        { error: true },
      );
    } finally {
      setBusy(false);
      textareaEl.focus();
    }
  }

  function setBusy(busy) {
    sendBtn.disabled = busy;
    textareaEl.disabled = busy;
  }

  // ----- Random blinking -----
  const blinkTimer = startBlinking([leftEye, rightEye]);

  // ----- Brand-colour cycling on the logo -----
  const colorTimer = startColorCycle(logoEl);

  function destroy() {
    clearTimeout(blinkTimer.handle);
    clearTimeout(colorTimer.handle);
    cancelAnimationFrame(colorTimer.rafId);
    root.remove();
  }

  return { root, destroy };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadInitialState() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'open' ? 'open' : 'closed';
  } catch {
    return 'closed';
  }
}

function setState(root, state) {
  root.setAttribute('data-state', state);
  try { localStorage.setItem(STORAGE_KEY, state); } catch { /* ignore */ }
}

function appendMessage(container, role, text, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = `cw-msg cw-msg--${role}${error ? ' cw-msg--error' : ''}`;
  el.textContent = text;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function appendTyping(container) {
  const el = document.createElement('div');
  el.className = 'cw-msg cw-msg--assistant cw-msg--typing';
  el.innerHTML = '<span class="cw-dot"></span><span class="cw-dot"></span><span class="cw-dot"></span>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

function autosize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

/**
 * POST a chat message and return the assistant's reply text.
 *
 * @param {string} message
 * @param {Array<{role: string, content: string}>} history
 * @returns {Promise<string>}
 */
export async function sendChat(message, history) {
  const res = await fetch(CHAT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail || ''; } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  const data = await res.json();
  return data?.response ?? '';
}

/**
 * Trigger a random blink roughly every 10 seconds.
 *
 * @param {HTMLElement[]} eyes
 */
function startBlinking(eyes) {
  const state = { handle: 0 };
  function schedule() {
    // Random interval 6–14 seconds.
    const delay = 6000 + Math.random() * 8000;
    state.handle = setTimeout(() => {
      blink(eyes);
      // Occasional double-blink for personality.
      if (Math.random() < 0.2) {
        setTimeout(() => blink(eyes), 280);
      }
      schedule();
    }, delay);
  }
  schedule();
  return state;
}

function blink(eyes) {
  for (const eye of eyes) {
    eye.classList.remove('cw-eye--blink');
    // Force reflow so the animation restarts even on consecutive blinks.
    void eye.offsetWidth;
    eye.classList.add('cw-eye--blink');
  }
}

// ---------------------------------------------------------------------------
// Colour helpers — HSL interpolation avoids the gray/black midpoint that
// sRGB interpolation (CSS transitions) produces for complementary colours.
// ---------------------------------------------------------------------------

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    default: h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(hue2rgb(h + 1 / 3) * 255), Math.round(hue2rgb(h) * 255), Math.round(hue2rgb(h - 1 / 3) * 255)];
}

/** Interpolate two HSL triples, taking the short arc around the hue wheel. */
function lerpHsl(a, b, t) {
  let dh = b[0] - a[0];
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return [
    a[0] + dh * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * AIND brand palette as [r, g, b] tuples, pre-converted to HSL for fast lerp.
 */
const BRAND_COLORS_HSL = [
  [100, 100, 255],
  [130, 70,  255],
  [205, 15,  85],
  [0,   165, 155],
  [205, 235, 5],
  [255, 0,   255],
  [255, 110, 0],
  [220, 150, 0],
  [255, 235, 35],
].map(([r, g, b]) => rgbToHsl(r, g, b));

const FADE_DURATION = 7000; // ms

/**
 * Pick a new random brand colour every 10–20 s and smoothly animate to it
 * via HSL interpolation (requestAnimationFrame), keeping hues vivid throughout.
 *
 * @param {HTMLElement} logoEl
 * @returns {{ handle: number, rafId: number }}
 */
function startColorCycle(logoEl) {
  const state = { handle: 0, rafId: 0, last: -1 };
  let currentHsl = [...BRAND_COLORS_HSL[0]];

  function pickNext() {
    let idx = Math.floor(Math.random() * BRAND_COLORS_HSL.length);
    if (idx === state.last) idx = (idx + 1) % BRAND_COLORS_HSL.length;
    state.last = idx;
    return idx;
  }

  function animateTo(targetHsl) {
    const fromHsl = [...currentHsl];
    const startTime = performance.now();
    cancelAnimationFrame(state.rafId);

    function frame(now) {
      const raw = Math.min((now - startTime) / FADE_DURATION, 1);
      // Ease in-out cubic.
      const t = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      const hsl = lerpHsl(fromHsl, targetHsl, t);
      currentHsl = hsl;
      const [r, g, b] = hslToRgb(hsl[0], hsl[1], hsl[2]);
      logoEl.style.backgroundColor = `rgb(${r},${g},${b})`;
      if (raw < 1) {
        state.rafId = requestAnimationFrame(frame);
      } else {
        currentHsl = [...targetHsl];
      }
    }

    state.rafId = requestAnimationFrame(frame);
  }

  function tick() {
    const delay = 10000 + Math.random() * 10000;
    state.handle = setTimeout(() => {
      animateTo(BRAND_COLORS_HSL[pickNext()]);
      tick();
    }, delay);
  }

  // Set initial colour immediately (no fade needed at mount time).
  const initIdx = pickNext();
  currentHsl = [...BRAND_COLORS_HSL[initIdx]];
  const [r, g, b] = hslToRgb(currentHsl[0], currentHsl[1], currentHsl[2]);
  logoEl.style.backgroundColor = `rgb(${r},${g},${b})`;
  tick();
  return state;
}
