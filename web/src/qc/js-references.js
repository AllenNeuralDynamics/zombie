import { renderNeuroglancer, NEUROGLANCER_ACTION_LABELS } from './js-renderers/neuroglancer.js';

/**
 * Allowed `js:<type>` renderers: (params: URLSearchParams, ctx) => HTMLElement.
 * A renderer may attach `el.qcActions = { [name]: (args: string) => void }` to support
 * `action=<name>:<args>` params on references.
 */
const RENDERERS = {
  neuroglancer: renderNeuroglancer,
};

const ACTION_LABELS = {
  neuroglancer: NEUROGLANCER_ACTION_LABELS,
};

export function isJsReference(reference) {
  return typeof reference === 'string' && /^js:/i.test(reference.trim());
}

function parseAction(value) {
  const i = value.indexOf(':');
  const name = (i === -1 ? value : value.slice(0, i)).trim().toLowerCase();
  return name ? { name, args: i === -1 ? '' : value.slice(i + 1).trim() } : null;
}

/** Returns `{ type, params, actions }`; reserved `action` params are removed from `params`. */
export function parseJsReference(reference) {
  if (!isJsReference(reference)) return null;
  const body = reference.trim().slice(3);
  const q = body.indexOf('?');
  const type = (q === -1 ? body : body.slice(0, q)).trim().toLowerCase();
  const params = new URLSearchParams(q === -1 ? '' : body.slice(q + 1));
  const actions = params.getAll('action').map(parseAction).filter(Boolean);
  params.delete('action');
  return { type, params, actions };
}

/** The reference with `action` params removed; metrics sharing a key share one rendered view. */
export function referenceGroupKey(reference) {
  const parsed = parseJsReference(reference);
  if (!parsed) return reference ?? '';
  const query = parsed.params.toString();
  return `js:${parsed.type}${query ? `?${query}` : ''}`;
}

export function referenceActions(reference) {
  return parseJsReference(reference)?.actions ?? [];
}

export function describeJsAction(reference, action) {
  const labels = ACTION_LABELS[parseJsReference(reference)?.type] ?? {};
  const label = Object.hasOwn(labels, action.name) ? labels[action.name] : action.name;
  return action.args ? `${label} ${action.args}` : label;
}

/** Runs an action against an element returned by `renderJsReference`. */
export function runJsAction(element, action) {
  const handler = element?.qcActions?.[action.name];
  if (typeof handler !== 'function') {
    console.warn(`unsupported js reference action "${action.name}"`);
    return false;
  }
  try {
    handler(action.args);
    return true;
  } catch (e) {
    console.error('js reference action failed', e);
    return false;
  }
}

function renderError(message) {
  const p = document.createElement('p');
  p.className = 'qc-media-error';
  p.textContent = message;
  return p;
}

/** Renders the reference once, then applies any actions it carries. */
export function renderJsReference(reference, ctx = {}) {
  const parsed = parseJsReference(reference);
  const renderer = parsed && Object.hasOwn(RENDERERS, parsed.type) ? RENDERERS[parsed.type] : null;
  if (!renderer) return renderError(`Unknown visualization type "${parsed?.type ?? ''}".`);
  let element;
  try {
    element = renderer(parsed.params, ctx);
  } catch (e) {
    console.error('js reference render failed', e);
    return renderError(`Could not build ${parsed.type} view: ${e.message}`);
  }
  for (const action of parsed.actions) runJsAction(element, action);
  return element;
}
