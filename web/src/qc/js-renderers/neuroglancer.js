import {
  fetchImageContrast,
  fetchSkeletonBounds,
  fetchSkeletonSegmentIds,
  extraGlobalDimensions,
  openOmeZarr,
  s3Https,
} from './neuroglancer-data.js';

const NG_EMBED_PATH = '/ng/index.html';
const NG_PUBLIC_BASE = 'https://neuroglancer-demo.appspot.com';

function isDarkMode() {
  const t = document.documentElement?.dataset?.theme;
  if (t === 'dark' || t === 'light') return t === 'dark';
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function requireS3(value, name) {
  const v = value.trim();
  if (!/^s3:\/\/[^/]+\/.+/.test(v)) throw new Error(`${name} must be an s3:// URL`);
  return v.replace(/\/+$/, '');
}

/** Copy of `params` with relative `image`/`skeleton` paths joined onto the asset's S3 location. */
export function resolveNeuroglancerParams(params, { s3Bucket, s3Prefix } = {}) {
  const resolved = new URLSearchParams(params);
  for (const name of ['image', 'skeleton']) {
    const value = resolved.get(name)?.trim();
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value)) continue;
    if (!s3Bucket || !s3Prefix) throw new Error(`${name} is a relative path but the asset has no S3 location`);
    resolved.set(name, `s3://${s3Bucket}/${s3Prefix.replace(/^\/+|\/+$/g, '')}/${value.replace(/^\/+/, '')}`);
  }
  return resolved;
}

/**
 * Params: `image` (s3:// zarr), `skeleton` (s3:// precomputed skeletons),
 * optional `segments` (comma-separated skeleton IDs to show) and
 * `range` (image contrast as `lo,hi`).
 */
export function buildNeuroglancerState(params) {
  const image = params.get('image');
  const skeleton = params.get('skeleton');
  if (!image && !skeleton) throw new Error('needs an image or skeleton parameter');
  const layers = [];
  if (image) {
    const layer = { type: 'image', source: `zarr://${requireS3(image, 'image')}`, name: 'image' };
    const range = (params.get('range') ?? '').split(',').map(Number);
    if (range.length === 2 && range.every(Number.isFinite)) {
      layer.shaderControls = { normalized: { range } };
    }
    layers.push(layer);
  }
  if (skeleton) {
    const segments = (params.get('segments') ?? '').split(',').map(s => s.trim()).filter(Boolean);
    layers.push({
      type: 'segmentation',
      source: `precomputed://${requireS3(skeleton, 'skeleton')}`,
      name: 'skeleton',
      skeletonRendering: { mode2d: 'lines_and_points', lineWidth3d: 2 },
      ...(segments.length ? { segments } : {}),
    });
  }
  // Mirrors exaspim/morphology.js buildNgState display defaults.
  const background = isDarkMode() ? '#141414' : '#f3f4f5';
  return {
    // Listing x/y/z first makes them the display axes even when the image has t/c axes.
    dimensions: { x: [1e-6, 'm'], y: [1e-6, 'm'], z: [1e-6, 'm'] },
    projectionBackgroundColor: background,
    crossSectionBackgroundColor: background,
    layers,
    layout: '4panel',
    // Negative = screen pixels; Neuroglancer's default slab (-10) buries the image under projected skeletons.
    crossSectionDepth: -1,
    layerListPanel: { visible: false },
    selection: { visible: false },
    showAxisLines: false,
    showDefaultAnnotations: false,
  };
}

export function neuroglancerFragment(state) {
  return `#!${encodeURIComponent(JSON.stringify(state))}`;
}

/** Centers the view on a bounding box (nm) and zooms to fit it. */
export function fitViewToBounds(state, boundsNm, panelPx = 500) {
  const center = [0, 1, 2].map(a => (boundsNm.min[a] + boundsNm.max[a]) / 2 / 1000);
  const extentUm = Math.max(...[0, 1, 2].map(a => boundsNm.max[a] - boundsNm.min[a])) / 1000;
  state.position = center;
  state.crossSectionScale = Math.max(extentUm * 1.1 / panelPx, 0.1);
  state.projectionScale = Math.max(extentUm * 1.5, 1);
  return state;
}

/** Fills in skeleton segments, view bounds and image contrast from the data. */
export async function enrichNeuroglancerState(state, params, { fetchImpl = fetch, signal } = {}) {
  const skeletonLayer = state.layers.find(l => l.name === 'skeleton');
  const imageLayer = state.layers.find(l => l.name === 'image');
  let bounds = null;
  if (skeletonLayer) {
    const base = s3Https(requireS3(params.get('skeleton'), 'skeleton'));
    if (!skeletonLayer.segments) {
      const ids = await fetchSkeletonSegmentIds(base, fetchImpl, signal).catch(warn('segment lookup'));
      if (ids?.length) skeletonLayer.segments = ids;
    }
    if (skeletonLayer.segments) {
      bounds = await fetchSkeletonBounds(base, skeletonLayer.segments, fetchImpl, signal).catch(warn('skeleton bounds'));
      if (bounds) fitViewToBounds(state, bounds);
    }
  }
  if (imageLayer && !signal?.aborted) {
    const base = s3Https(requireS3(params.get('image'), 'image'));
    const ome = await openOmeZarr(base).catch(warn('image metadata'));
    if (ome) {
      // Neuroglancer drops `position` unless it covers every global dimension.
      const extra = extraGlobalDimensions(ome.multiscale);
      Object.assign(state.dimensions, extra);
      if (state.position) state.position.push(...Object.keys(extra).map(() => 0));
      if (!imageLayer.shaderControls) {
        const range = await fetchImageContrast(ome, bounds, { signal }).catch(warn('image contrast'));
        if (range && range[1] > range[0]) imageLayer.shaderControls = { normalized: { range } };
      }
    }
  }
  return state;
}

function warn(what) {
  return (e) => { console.warn(`neuroglancer ${what} failed`, e); return null; };
}

export const NEUROGLANCER_ACTION_LABELS = {
  segments: 'Show segments',
  goto: 'Go to',
};

function parseIds(args) {
  return String(args ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function parsePoint(args) {
  const p = String(args ?? '').split(',').map(Number);
  if (p.length !== 3 || !p.every(Number.isFinite)) throw new Error('goto needs x,y,z');
  return p;
}

/**
 * Action handlers that mutate `state` and call `show(state)`.
 * `segments:<id,id>` selects skeleton segments and fits the view to them;
 * `goto:<x,y,z>` centers on a point (µm, matching the state dimensions).
 */
export function createNeuroglancerActions(state, params, show, { fetchImpl = fetch } = {}) {
  let latest = 0;
  return {
    segments(args) {
      const ids = parseIds(args);
      const layer = state.layers.find(l => l.name === 'skeleton');
      if (!layer || !ids.length) return;
      layer.segments = ids;
      show(state);
      const run = ++latest;
      const base = s3Https(requireS3(params.get('skeleton'), 'skeleton'));
      fetchSkeletonBounds(base, ids, fetchImpl)
        .then((bounds) => {
          if (bounds && run === latest) { fitViewToBounds(state, bounds); show(state); }
        })
        .catch(warn('segment bounds'));
    },
    goto(args) {
      const point = parsePoint(args);
      ++latest;
      const extra = Object.keys(state.dimensions).slice(3).map((_, i) => state.position?.[3 + i] ?? 0);
      state.position = [...point, ...extra];
      show(state);
    },
  };
}

export function renderNeuroglancer(rawParams, ctx = {}) {
  const params = resolveNeuroglancerParams(rawParams, ctx);
  const state = buildNeuroglancerState(params);
  const wrapper = document.createElement('div');
  wrapper.className = 'qc-media-js-neuroglancer';
  const iframe = document.createElement('iframe');
  const popout = document.createElement('a');
  let ready = false;
  const pending = [];
  const show = (st) => {
    if (!ready) return;
    const fragment = neuroglancerFragment(st);
    // Same-origin embed: later updates go through its postMessage API (see exaspim/morphology.js)
    // so the viewer isn't reloaded; the embed buffers messages until it has mounted.
    if (iframe.src) iframe.contentWindow?.postMessage({ type: 'setState', state: st }, '*');
    else iframe.src = `${NG_EMBED_PATH}${fragment}`;
    popout.href = `${NG_PUBLIC_BASE}/${fragment}`;
  };
  const handlers = createNeuroglancerActions(state, params, show);
  // Actions requested before enrichment finishes are replayed after it, so they win over defaults.
  wrapper.qcActions = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [
    name,
    (args) => (ready ? fn(args) : pending.push(() => fn(args))),
  ]));
  enrichNeuroglancerState(state, params).finally(() => {
    ready = true;
    show(state);
    for (const run of pending.splice(0)) run();
  });
  iframe.setAttribute('allowfullscreen', '');
  const actions = document.createElement('div');
  const fullscreen = document.createElement('button');
  fullscreen.type = 'button';
  fullscreen.className = 'qc-fullscreen-btn';
  fullscreen.textContent = '⛶';
  fullscreen.addEventListener('click', () => iframe.requestFullscreen?.());
  popout.target = '_blank';
  popout.rel = 'noopener noreferrer';
  popout.textContent = 'Open in Neuroglancer';
  actions.append(fullscreen, popout);
  wrapper.append(iframe, actions);
  return wrapper;
}
