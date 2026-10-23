import { renderNeuroglancer } from './js-renderers/neuroglancer.js';

/** Allowed `js:<type>` renderers: (params: URLSearchParams, ctx) => HTMLElement. */
const RENDERERS = {
  neuroglancer: renderNeuroglancer,
};

export function isJsReference(reference) {
  return typeof reference === 'string' && /^js:/i.test(reference.trim());
}

export function parseJsReference(reference) {
  if (!isJsReference(reference)) return null;
  const body = reference.trim().slice(3);
  const q = body.indexOf('?');
  const type = (q === -1 ? body : body.slice(0, q)).trim().toLowerCase();
  const params = new URLSearchParams(q === -1 ? '' : body.slice(q + 1));
  return { type, params };
}

function renderError(message) {
  const p = document.createElement('p');
  p.className = 'qc-media-error';
  p.textContent = message;
  return p;
}

export function renderJsReference(reference, ctx = {}) {
  const parsed = parseJsReference(reference);
  const renderer = parsed && Object.hasOwn(RENDERERS, parsed.type) ? RENDERERS[parsed.type] : null;
  if (!renderer) return renderError(`Unknown visualization type "${parsed?.type ?? ''}".`);
  try {
    return renderer(parsed.params, ctx);
  } catch (e) {
    console.error('js reference render failed', e);
    return renderError(`Could not build ${parsed.type} view: ${e.message}`);
  }
}
