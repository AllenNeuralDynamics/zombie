/**
 * exaspim/morphology.js — Embedded "Neuron Morphology" viewer for the ExaSPIM
 * platform page.
 *
 * Embeds a Neuroglancer iframe (neuroglancer-demo.appspot.com) showing two
 * precomputed sources from the AIND Neuron Morphology Community Portal:
 *   - CCF reference atlas (gs://allen_neuroglancer_ccf/ccf_test1)
 *   - Reconstructed neuron skeletons under
 *     s3://aind-neuron-morphology-community-portal-prod-o5171v/ngv01/{full,axon,dendrite}
 *
 * UI:
 *   - Left column: a collapsible CCF region tree (search + select shown +
 *     clear), and a single "Neurons" panel whose "Search neurons…" button opens
 *     a unified modal. One text box searches CCF acronyms, full area names and
 *     neuron labels across BOTH datasets (AIND meshes + Janelia MouseLight);
 *     exact CCF matches pin as removable chips, a Both/AIND/MouseLight toggle
 *     limits the scope, and ticked results apply to the viewer.
 *   - Right column: the Neuroglancer iframe.
 *
 * State sync: we write the iframe `src` with the same base host and only the
 * URL fragment differs between updates. Browsers treat this as a fragment
 * navigation (hashchange) without document reload, and Neuroglancer keeps the
 * camera position because we don't include position/projectionScale/etc in
 * the state we send.
 */

import {
  fetchMouseLightNeurons,
  fetchMouseLightNeuronsCached,
  fetchMouseLightTracings,
  buildMouseLightAnnotationLayer,
  mouseLightColor,
} from './mouselight.js';
import { createProjection2DView } from './projection2d-view.js';
import {
  PLANES,
  PLANE_KEYS,
  getCcfOutlineSegments,
  loadAindSkeleton,
  projectEdgesToSegments,
  tracingsToSkeleton,
  boundsOfItems,
} from './projection2d.js';

// ─── External endpoints ─────────────────────────────────────────────────────

const PORTAL_BASE = 'https://morphology.allenneuraldynamics.org';
const GRAPHQL_URL = `${PORTAL_BASE}/graphql`;

/**
 * Self-hosted Neuroglancer (vendored under `web/public/ng/`) — same-origin so
 * we can drive it via `postMessage` and keep the user's camera between
 * updates. The pop-out link still points at the public demo for shareability.
 */
const NEUROGLANCER_EMBED_PATH = '/ng/index.html';
const NEUROGLANCER_PUBLIC_BASE = 'https://neuroglancer-demo.appspot.com';

const NEURON_BUCKET_BASE = 'precomputed://s3://aind-neuron-morphology-community-portal-prod-o5171v/ngv01';
/** Per-compartment precomputed sources. */
const NEURON_SOURCES = {
  full: `${NEURON_BUCKET_BASE}/full`,
  axon: `${NEURON_BUCKET_BASE}/axon`,
  dendrite: `${NEURON_BUCKET_BASE}/dendrite`,
};
const COMPARTMENTS = ['full', 'axon', 'dendrite'];

/** Per-compartment segment_properties.info URLs (label → numeric segment id). */
const NEURON_SEG_PROPS_URL = 'https://aind-neuron-morphology-community-portal-prod-o5171v.s3.amazonaws.com/ngv01/full/segment_properties/info';

/**
 * Default Neuroglancer state, copied byte-for-byte from the morphology
 * portal's own bundle (variable `Iee` in their `bundle.js`):
 *
 *   {dimensions:{x:[1e-5,"m"], y:[1e-5,"m"], z:[1e-5,"m"]},
 *    position:[659.5,399.5,569.5],
 *    projectionOrientation:[-.2892..., .4539..., .1698..., .8254...],
 *    crossSectionScale:2.7182818284590446,
 *    projectionScale:1536,
 *    showAxisLines:false, layout:"3d",
 *    layerListPanel:{visible:false}, selection:{visible:false},
 *    showDefaultAnnotations:false}
 *
 * The dimensions MUST be 1e-5 (10µm) — that's the CCF atlas voxel size and
 * the units of the camera position. Using 1e-6 here made the brain appear
 * 10× too small and offset, and pushed every neuron mesh outside the visible
 * frustum.
 */
const PORTAL_DIMENSIONS = { x: [1e-5, 'm'], y: [1e-5, 'm'], z: [1e-5, 'm'] };
const DEFAULT_CAMERA = {
  position: [659.5, 399.5, 569.5],
  projectionOrientation: [
    -0.2892743945121765,
    0.45396557450294495,
    0.1698378622531891,
    0.8254639506340027,
  ],
  projectionScale: 1536,
  crossSectionScale: 2.7182818284590446,
};

/** Precomputed segmentation: CCF reference atlas (meshes per structureId). */
const CCF_SOURCE = 'precomputed://gs://allen_neuroglancer_ccf/ccf_test1';

/** CCF structure id of the whole-brain root outline. */
const CCF_ROOT_SEGMENT = '997';
/** The root shell stays very translucent so you can see inside the brain. */
const CCF_ROOT_ALPHA = 0.18;
/** Non-root regions are rendered more opaque so they read clearly. */
const CCF_REGION_ALPHA = 0.3;

// ─── GraphQL ────────────────────────────────────────────────────────────────

const ATLAS_QUERY = `query CcfStructures {
  atlasStructures {
    id name acronym structureId parentStructureId
    structureIdPath defaultColor hasGeometry
  }
}`;

async function gql(query, variables, signal) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message ?? 'GraphQL error');
  return body.data;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * Build a Neuroglancer JSON state from selected CCF + per-compartment neurons.
 *
 * @param {string[]} ccfSegments  CCF structure IDs (numeric strings).
 * @param {{full:string[], axon:string[], dendrite:string[]}} neuronsByComp
 *   Each value is an array of NUMERIC neuron segment ids (as strings), NOT
 *   portal UUIDs — those numbers are what Neuroglancer parses out of the
 *   precomputed segmentation's `segment_properties/info`.
 * @param {object} [camera]  Override camera fields (position, etc).
 * @param {object[]} [extraLayers]  Additional Neuroglancer layer objects to
 *   append after the CCF + neuron layers (e.g. MouseLight annotation layers).
 * @param {Map<string,string>|null} [ccfColors]  Lookup from CCF structure id
 *   (string) → CSS colour (e.g. "#ff4c3e"). When provided, the CCF
 *   segmentation layer gets a `segmentColors` map so each region renders in
 *   its Allen atlas colour instead of Neuroglancer's hashed default.
 * @param {Map<string,string>|null} [neuronColors]  Lookup from NUMERIC neuron
 *   segment id (string) → CSS colour. When provided, the neuron segmentation
 *   layers get a `segmentColors` map so each neuron renders in its chosen
 *   colour.
 */
export function buildNgState(
  ccfSegments,
  neuronsByComp = { full: [], axon: [], dendrite: [] },
  extraLayers = [],
  camera = DEFAULT_CAMERA,
  ccfColors = null,
  neuronColors = null,
) {
  // The root outline and the inner regions need different opacity, and
  // Neuroglancer's `objectAlpha` is per-layer — so split the CCF source into
  // a translucent "ccf" root layer and a more opaque "ccf-regions" layer.
  const makeCcfLayer = (name, segIds, alpha, silhouette) => {
    const layer = {
      type: 'segmentation',
      source: CCF_SOURCE,
      name,
      objectAlpha: alpha,
      segments: segIds.map(String),
    };
    if (silhouette) layer.meshSilhouetteRendering = 3;
    if (ccfColors) {
      const segmentColors = {};
      for (const id of segIds) {
        const c = ccfColors.get(String(id));
        if (c) segmentColors[String(id)] = c;
      }
      if (Object.keys(segmentColors).length > 0) layer.segmentColors = segmentColors;
    }
    return layer;
  };

  const rootSegs = ccfSegments.filter((id) => String(id) === CCF_ROOT_SEGMENT);
  const regionSegs = ccfSegments.filter((id) => String(id) !== CCF_ROOT_SEGMENT);
  const layers = [makeCcfLayer('ccf', rootSegs, CCF_ROOT_ALPHA, true)];
  if (regionSegs.length > 0) {
    layers.push(makeCcfLayer('ccf-regions', regionSegs, CCF_REGION_ALPHA, false));
  }
  for (const comp of COMPARTMENTS) {
    const ids = neuronsByComp?.[comp] ?? [];
    if (ids.length === 0) continue;
    const layer = {
      type: 'segmentation',
      source: NEURON_SOURCES[comp],
      name: comp === 'full' ? 'neurons' : `neurons-${comp}`,
      segments: ids.map(String),
      skeletonRendering: { mode2d: 'lines_and_points', lineWidth3d: 2 },
    };
    if (neuronColors) {
      const segmentColors = {};
      for (const id of ids) {
        const c = neuronColors.get(String(id));
        if (c) segmentColors[String(id)] = c;
      }
      if (Object.keys(segmentColors).length > 0) layer.segmentColors = segmentColors;
    }
    layers.push(layer);
  }
  for (const layer of extraLayers ?? []) layers.push(layer);
  // Shape mirrors the portal's `Iee` default state exactly so the camera and
  // scene framing match their viewer 1:1.
  return {
    dimensions: PORTAL_DIMENSIONS,
    position: camera.position,
    projectionOrientation: camera.projectionOrientation,
    projectionScale: camera.projectionScale,
    crossSectionScale: camera.crossSectionScale,
    // Light WebGL clear color so the perspective panel reads as white against
    // our app's light theme — matches morphology.allenneuraldynamics.org.
    projectionBackgroundColor: '#f3f4f5',
    crossSectionBackgroundColor: '#f3f4f5',
    layers,
    layout: '3d',
    layerListPanel: { visible: false },
    selection: { visible: false },
    showAxisLines: false,
    showDefaultAnnotations: false,
  };
}

export function buildNgUrl(state) {
  return `${NEUROGLANCER_PUBLIC_BASE}/#!${encodeURIComponent(JSON.stringify(state))}`;
}

/**
 * Encode the 3D camera (orientation quaternion + projection scale + position)
 * into a compact comma-separated URL value so a shared link reproduces the
 * exact view without bloating the URL with full Neuroglancer JSON. Returns ''
 * when the camera is malformed.
 */
export function encodeCamera(cam) {
  const o = cam?.projectionOrientation;
  if (!Array.isArray(o) || o.length !== 4) return '';
  const nums = [
    ...o.map((n) => +Number(n).toFixed(5)),
    +Number(cam.projectionScale ?? 0).toFixed(3),
    ...(Array.isArray(cam.position) ? cam.position.map((n) => +Number(n).toFixed(2)) : []),
  ];
  return nums.join(',');
}

/** Parse an {@link encodeCamera} value back into a camera object, or null. */
export function decodeCamera(str) {
  if (!str) return null;
  const parts = String(str).split(',').map(Number);
  if (parts.length < 5 || parts.some((n) => Number.isNaN(n))) return null;
  const [q0, q1, q2, q3, scale, ...pos] = parts;
  return {
    projectionOrientation: [q0, q1, q2, q3],
    projectionScale: scale,
    crossSectionScale: DEFAULT_CAMERA.crossSectionScale,
    position: pos.length === 3 ? pos : DEFAULT_CAMERA.position,
  };
}

/**
 * Build a hierarchical tree of CCF structures.
 *
 * Returns `{ roots, byId }` where:
 *   - `byId` is a Map<structureId(str), node>
 *   - each node = { id, acronym, name, depth, color, hasGeometry, parentId, children: [] }
 *   - depth derives from `structureIdPath` length, so leaf layers like VISp1
 *     end up one level deeper than their parent VISp.
 *   - children are sorted by acronym (case-insensitive) for stable display.
 *   - `roots` is the array of top-level nodes (those whose parentStructureId
 *     is null or not present in the input).
 */
export function buildAtlasTree(structures) {
  const byId = new Map();
  for (const s of structures) {
    if (s == null || s.structureId == null) continue;
    const path = String(s.structureIdPath ?? '').split('/').filter(Boolean);
    const depth = Math.max(0, path.length - 1);
    byId.set(String(s.structureId), {
      id: String(s.structureId),
      uuid: s.id ?? null,
      acronym: s.acronym ?? '',
      name: s.name ?? '',
      depth,
      color: s.defaultColor ?? null,
      hasGeometry: !!s.hasGeometry,
      parentId: s.parentStructureId != null ? String(s.parentStructureId) : null,
      children: [],
    });
  }
  const roots = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  const cmp = (a, b) => a.acronym.localeCompare(b.acronym, undefined, { sensitivity: 'base' });
  for (const node of byId.values()) node.children.sort(cmp);
  roots.sort(cmp);
  return { roots, byId };
}

/**
 * Legacy flat list (kept for backwards compat). Now produced from
 * buildAtlasTree so depth matches path-length.
 */
export function flattenAtlas(structures) {
  const { roots, byId } = buildAtlasTree(structures);
  const out = [];
  function walk(node) {
    if (node.hasGeometry) {
      out.push({
        id: node.id,
        acronym: node.acronym,
        name: node.name,
        depth: node.depth,
        color: node.color,
      });
    }
    for (const c of node.children) walk(c);
  }
  for (const r of roots) walk(r);
  return out;
}

/**
 * Parse the precomputed segmentation's segment_properties.info into a list of
 * `{ id, label, region }` rows, where `id` is the NUMERIC segment id that
 * Neuroglancer expects in the layer's `segments` array.
 *
 * The portal's `candidateNeurons` GraphQL returns UUIDs for ALL ~79K neurons,
 * but only ~131 currently have published precomputed meshes. We join by label
 * (e.g. "N001") to map UUID-results back to numeric segment ids that the NG
 * viewer can actually render.
 */
export function parseSegmentProperties(info) {
  const ids = info?.inline?.ids ?? [];
  const props = info?.inline?.properties ?? [];
  const labelProp = props.find((p) => p.id === 'label');
  const tagsProp = props.find((p) => p.id === 'tags');
  const tagLabels = tagsProp?.tags ?? [];
  const labels = labelProp?.values ?? [];
  const tagsVals = tagsProp?.values ?? [];
  return ids.map((id, i) => {
    const raw = tagsVals[i];
    let tagIdx = null;
    if (Array.isArray(raw)) tagIdx = raw[0];
    else if (typeof raw === 'number') tagIdx = raw;
    else if (typeof raw === 'string') {
      const m = raw.match(/\d+/);
      tagIdx = m ? Number(m[0]) : null;
    }
    const region = tagIdx != null && tagIdx >= 0 && tagIdx < tagLabels.length ? tagLabels[tagIdx] : '';
    return { id: String(id), label: String(labels[i] ?? ''), region };
  });
}

/**
 * Walk a CCF tree node up to the root, returning the list of structure ids
 * (self first, then ancestors). Used so a region filter for a parent area
 * (e.g. "Isocortex") also matches neurons whose soma sits in any descendant.
 */
function ancestorIds(node, byId) {
  const out = [];
  let cur = node;
  let guard = 0;
  while (cur && guard < 64) {
    out.push(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
    guard += 1;
  }
  return out;
}

/**
 * Build a unified neuron item used by the search modal + panel for both
 * datasets. `dataset` is 'aind' | 'ml'. `fields` carries the dataset-specific
 * identifiers ({segmentId} for AIND, {idString,tracings} for MouseLight) plus a
 * soma `region` acronym and `label`.
 */
function makeNeuronItem(dataset, fields, acronymToNode, byId) {
  const region = fields.region || '';
  const node = region ? acronymToNode.get(region.toLowerCase()) : null;
  const regionName = node?.name || '';
  const regionAncestorIds = node ? ancestorIds(node, byId) : [];
  const label = fields.label || '';
  const searchText = `${label} ${region} ${regionName}`.toLowerCase();
  const key = dataset === 'aind' ? `aind:${fields.segmentId}` : `ml:${fields.idString}`;
  return {
    key, dataset, label, region, regionName, regionAncestorIds, searchText,
    segmentId: fields.segmentId, idString: fields.idString, tracings: fields.tracings,
  };
}

/**
 * Classify a single search token into an exact CCF match (acronym or full area
 * name → a region chip) or a free-text keyword. Matching is case-insensitive.
 *
 * @param {string} text
 * @param {{acronymToNode?:Map, nameToNode?:Map}} maps  Lowercase-keyed lookups.
 * @returns {null|{kind:'ccf',match:'acronym'|'name',structureId:string,acronym:string,name:string}|{kind:'keyword',text:string}}
 */
export function classifySearchToken(text, { acronymToNode, nameToNode } = {}) {
  const t = (text || '').trim();
  if (!t) return null;
  const lc = t.toLowerCase();
  const acr = acronymToNode?.get(lc);
  if (acr) return { kind: 'ccf', match: 'acronym', structureId: acr.id, acronym: acr.acronym, name: acr.name };
  const nm = nameToNode?.get(lc);
  if (nm) return { kind: 'ccf', match: 'name', structureId: nm.id, acronym: nm.acronym, name: nm.name };
  return { kind: 'keyword', text: t };
}

/**
 * Filter unified neuron items by region chips (OR across regions, hierarchical)
 * and keywords (AND, substring against label/region/area-name). Pure + tested.
 *
 * @param {Array} neurons  Items from makeNeuronItem.
 * @param {{regionIds?:string[], keywords?:string[]}} opts
 * @returns {Array}
 */
export function filterNeurons(neurons, { regionIds = [], keywords = [] } = {}) {
  const regionSet = regionIds.length ? new Set(regionIds.map(String)) : null;
  const kws = keywords.map((k) => String(k).toLowerCase()).filter(Boolean);
  return neurons.filter((n) => {
    if (regionSet) {
      const anc = n.regionAncestorIds || [];
      if (!anc.some((id) => regionSet.has(String(id)))) return false;
    }
    for (const kw of kws) {
      if (!(n.searchText || '').includes(kw)) return false;
    }
    return true;
  });
}

// ─── DOM helpers ────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let h = null;
  return (...args) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => { h = null; fn(...args); }, ms);
  };
}

/**
 * Render a collapsible CCF tree panel.
 *
 * @param {object} opts
 * @param {string}       opts.title
 * @param {Array}        opts.roots          From buildAtlasTree.
 * @param {Set<string>}  opts.selected       Mutated in place.
 * @param {() => void}   opts.onChange
 * @param {number}       [opts.defaultOpenDepth=2]  Nodes at depth ≤ this start open.
 */
function buildTreePanel({ title, roots, selected, onChange, defaultOpenDepth = 2 }) {
  const panel = document.createElement('div');
  panel.className = 'morph-panel sessions-filter-group';

  // Header
  const head = document.createElement('div');
  head.className = 'morph-panel-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'sessions-filter-label morph-panel-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const count = document.createElement('span');
  count.className = 'morph-panel-count';
  head.appendChild(count);
  panel.appendChild(head);

  // Search
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search…';
  search.className = 'smartspim-subject-search morph-panel-search';
  panel.appendChild(search);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'morph-panel-actions';
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'sessions-filter-clear';
  expandBtn.textContent = 'Expand';
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'sessions-filter-clear';
  collapseBtn.textContent = 'Collapse';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'sessions-filter-clear';
  clearBtn.textContent = 'Clear';
  actions.appendChild(expandBtn);
  actions.appendChild(collapseBtn);
  actions.appendChild(clearBtn);
  panel.appendChild(actions);

  // List
  const list = document.createElement('div');
  list.className = 'sessions-checkbox-list morph-panel-list morph-tree-list';
  panel.appendChild(list);

  // Track open state per node id and total selectable count for the counter.
  const open = new Map(); // id -> bool
  let totalSelectable = 0;

  function init(node) {
    if (node.hasGeometry) totalSelectable++;
    if (!open.has(node.id)) open.set(node.id, node.depth < defaultOpenDepth);
    for (const c of node.children) init(c);
  }
  for (const r of roots) init(r);

  function updateCount() {
    count.textContent = `${selected.size} / ${totalSelectable}`;
  }

  /**
   * Compute which nodes match the current search query, taking ancestors into
   * account: a match should keep its full ancestor chain visible and forces
   * those ancestors open.
   */
  function searchMatches(q) {
    if (!q) return { all: true, set: null, forceOpen: null };
    const lc = q.toLowerCase();
    const matched = new Set();
    function walk(node, ancestors) {
      const isMatch =
        node.acronym.toLowerCase().includes(lc) ||
        node.name.toLowerCase().includes(lc) ||
        node.id === lc;
      const childAncestors = [...ancestors, node];
      let anyChild = false;
      for (const c of node.children) anyChild = walk(c, childAncestors) || anyChild;
      if (isMatch || anyChild) {
        matched.add(node.id);
        for (const a of ancestors) matched.add(a.id);
        return true;
      }
      return false;
    }
    for (const r of roots) walk(r, []);
    return { all: false, set: matched, forceOpen: matched };
  }

  function render() {
    const q = search.value.trim();
    const { all, set: visible, forceOpen } = searchMatches(q);
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    function walkRender(node) {
      const visibleHere = all || (visible && visible.has(node.id));
      if (!visibleHere) return;
      const row = document.createElement('div');
      row.className = 'morph-tree-row';
      row.style.paddingLeft = `${Math.min(node.depth, 10) * 12}px`;

      // Toggle (▶/▼) or spacer.
      const tog = document.createElement('button');
      tog.type = 'button';
      tog.className = 'morph-tree-toggle';
      const hasKids = node.children.length > 0;
      const isOpen = (forceOpen && forceOpen.has(node.id)) || open.get(node.id);
      if (hasKids) {
        tog.textContent = isOpen ? '▼' : '▶';
        tog.setAttribute('aria-label', isOpen ? 'Collapse' : 'Expand');
        tog.addEventListener('click', () => {
          open.set(node.id, !open.get(node.id));
          render();
        });
      } else {
        tog.textContent = ' ';
        tog.disabled = true;
        tog.classList.add('morph-tree-toggle-empty');
      }
      row.appendChild(tog);

      // Checkbox (only for structures with geometry).
      if (node.hasGeometry) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = node.id;
        cb.checked = selected.has(node.id);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(node.id);
          else selected.delete(node.id);
          updateCount();
          onChange();
        });
        row.appendChild(cb);
      } else {
        const sp = document.createElement('span');
        sp.className = 'morph-tree-no-geom';
        row.appendChild(sp);
      }

      if (node.color) {
        const sw = document.createElement('span');
        sw.className = 'morph-color-swatch';
        sw.style.background = '#' + node.color;
        row.appendChild(sw);
      }

      const text = document.createElement('span');
      text.className = 'morph-tree-label';
      text.title = node.name;
      text.textContent = node.acronym || `(id ${node.id})`;
      const sub = document.createElement('span');
      sub.className = 'morph-tree-sub';
      sub.textContent = ' ' + node.name;
      text.appendChild(sub);
      row.appendChild(text);

      frag.appendChild(row);
      if (hasKids && isOpen) {
        for (const c of node.children) walkRender(c);
      }
    }
    for (const r of roots) walkRender(r);
    list.appendChild(frag);
    updateCount();
  }

  search.addEventListener('input', render);
  expandBtn.addEventListener('click', () => {
    for (const id of open.keys()) open.set(id, true);
    render();
  });
  collapseBtn.addEventListener('click', () => {
    for (const id of open.keys()) open.set(id, false);
    render();
  });
  clearBtn.addEventListener('click', () => {
    selected.clear();
    render();
    onChange();
  });

  render();
  return panel;
}

/** Feather-style eye / eye-off icons for the per-neuron visibility toggle. */
const EYE_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

/**
 * Compact "Neurons" panel shown in the controls column. It lists the neurons
 * currently displayed in the viewer (from both datasets) and is the single
 * entry point to the unified search modal — all searching/selection happens
 * there. See {@link openNeuronSearchModal}.
 *
 * @param {object} ctx  Shared morphology state (see createExaSpimMorphologySection).
 * @returns {HTMLElement}
 */
function buildNeuronPanel(ctx) {
  const panel = document.createElement('div');
  panel.className = 'morph-panel sessions-filter-group';

  // Header
  const head = document.createElement('div');
  head.className = 'morph-panel-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'sessions-filter-label morph-panel-title';
  titleEl.textContent = 'Neurons';
  head.appendChild(titleEl);
  const count = document.createElement('span');
  count.className = 'morph-panel-count';
  head.appendChild(count);
  panel.appendChild(head);

  // Single entry point: open the unified search modal.
  const searchBtn = document.createElement('button');
  searchBtn.type = 'button';
  searchBtn.className = 'morph-search-btn';
  searchBtn.innerHTML = '<span aria-hidden="true">⌕</span> Search neurons…';
  searchBtn.title = 'Search both datasets and choose neurons to display';
  panel.appendChild(searchBtn);

  // List of currently-displayed neurons.
  const list = document.createElement('div');
  list.className = 'sessions-checkbox-list morph-panel-list morph-selected-list';
  panel.appendChild(list);

  function selectedItems() {
    const out = [];
    for (const item of ctx.aindNeurons) {
      if (ctx.selectedNeurons.has(item.segmentId)) out.push(item);
    }
    const byId = new Map();
    for (const item of ctx.mlNeurons || []) byId.set(item.idString, item);
    for (const idString of ctx.selectedMouseLight) {
      out.push(
        byId.get(idString) || {
          key: `ml:${idString}`, dataset: 'ml', label: idString, idString, region: '', regionName: '',
        },
      );
    }
    return out;
  }

  function render() {
    const items = selectedItems();
    count.textContent = String(items.length);
    list.innerHTML = '';
    if (items.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty';
      empty.textContent = 'No neurons selected — use Search.';
      list.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const n of items) {
      const row = document.createElement('div');
      row.className = 'morph-neuron-row morph-selected-row';

      const badge = document.createElement('span');
      badge.className = `morph-badge morph-badge-${n.dataset}`;
      badge.textContent = n.dataset === 'aind' ? 'AIND' : 'ML';
      row.appendChild(badge);

      const text = document.createElement('span');
      text.className = 'morph-panel-item-text';
      text.textContent = n.label;
      if (n.region) {
        const sub = document.createElement('span');
        sub.className = 'morph-panel-item-sub';
        sub.textContent = ' · ' + n.region;
        text.appendChild(sub);
      }
      row.appendChild(text);

      // Colour picker — set the neuron's render colour.
      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'morph-color-input';
      color.title = 'Neuron colour';
      color.setAttribute('aria-label', `Colour for ${n.label}`);
      color.value = ctx.colorOf(n);
      color.addEventListener('input', () => {
        ctx.setColor(n, color.value);
        ctx.onChange();
      });
      row.appendChild(color);

      // Visibility toggle — hide/show in the viewer without deselecting.
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'morph-eye-btn';
      const hidden = ctx.hiddenNeurons.has(n.key);
      if (hidden) eye.classList.add('is-hidden');
      eye.title = hidden ? 'Show in viewer' : 'Hide from viewer';
      eye.setAttribute('aria-label', eye.title);
      eye.setAttribute('aria-pressed', String(hidden));
      eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_SVG;
      eye.addEventListener('click', () => {
        if (ctx.hiddenNeurons.has(n.key)) ctx.hiddenNeurons.delete(n.key);
        else ctx.hiddenNeurons.add(n.key);
        render();
        ctx.onChange();
      });
      row.appendChild(eye);

      if (n.dataset === 'aind') {
        const sel = document.createElement('select');
        sel.className = 'morph-compartment-select';
        sel.title = 'Display compartment';
        for (const c of COMPARTMENTS) {
          const opt = document.createElement('option');
          opt.value = c;
          opt.textContent = c;
          sel.appendChild(opt);
        }
        sel.value = ctx.compartmentByNeuron.get(n.segmentId) || 'full';
        sel.addEventListener('change', () => {
          ctx.compartmentByNeuron.set(n.segmentId, sel.value);
          ctx.onChange();
        });
        row.appendChild(sel);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'morph-remove-btn';
      remove.title = 'Remove from viewer';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        if (n.dataset === 'aind') ctx.selectedNeurons.delete(n.segmentId);
        else ctx.selectedMouseLight.delete(n.idString);
        ctx.hiddenNeurons.delete(n.key);
        render();
        ctx.onChange();
      });
      row.appendChild(remove);

      frag.appendChild(row);
    }
    list.appendChild(frag);
  }

  searchBtn.addEventListener('click', () => openNeuronSearchModal(ctx));
  ctx.refreshPanel = render;
  render();
  return panel;
}

/**
 * Unified neuron search modal — the single point of entry for finding neurons
 * across both datasets. One text box searches CCF acronyms, full area names and
 * neuron labels together; exact CCF matches pin as removable chips. Results
 * render live inside the modal so the user can review and tick neurons before
 * hitting Apply. A Both/AIND/MouseLight toggle limits the search to one source.
 *
 * @param {object} ctx  Shared morphology state (see createExaSpimMorphologySection).
 */
function openNeuronSearchModal(ctx) {
  let scope = 'both'; // 'both' | 'aind' | 'ml'
  /** @type {Array<{kind:'ccf'|'keyword', structureId?, acronym?, name?, match?, text?}>} */
  const chips = [];
  /** key → unified neuron item: the to-be-applied selection. */
  const chosen = new Map();
  for (const item of ctx.aindNeurons) {
    if (ctx.selectedNeurons.has(item.segmentId)) chosen.set(item.key, item);
  }
  for (const item of ctx.mlNeurons || []) {
    if (ctx.selectedMouseLight.has(item.idString)) chosen.set(item.key, item);
  }

  const overlay = document.createElement('div');
  overlay.className = 'morph-modal-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'morph-modal morph-modal-wide';
  overlay.appendChild(dialog);

  const h = document.createElement('h4');
  h.textContent = 'Search neurons';
  h.className = 'morph-modal-title';
  dialog.appendChild(h);

  // Dataset scope (Both / AIND / MouseLight)
  const scopeRow = document.createElement('div');
  scopeRow.className = 'morph-dataset-toggle';
  const scopeButtons = new Map();
  for (const o of [
    { id: 'both', label: 'Both' },
    { id: 'aind', label: 'AIND' },
    { id: 'ml', label: 'MouseLight' },
  ]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'morph-dataset-opt';
    b.textContent = o.label;
    if (o.id === scope) b.classList.add('active');
    b.addEventListener('click', () => {
      scope = o.id;
      for (const [id, btn] of scopeButtons) btn.classList.toggle('active', id === scope);
      runSearch();
    });
    scopeButtons.set(o.id, b);
    scopeRow.appendChild(b);
  }
  dialog.appendChild(scopeRow);

  // Single search box.
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'morph-modal-input morph-modal-search';
  search.placeholder = 'Search CCF acronyms, area names, or neuron labels…';
  dialog.appendChild(search);

  // Active exact-match chips.
  const chipsEl = document.createElement('div');
  chipsEl.className = 'morph-chips';
  dialog.appendChild(chipsEl);

  // Results.
  const resultsHead = document.createElement('div');
  resultsHead.className = 'morph-results-head';
  dialog.appendChild(resultsHead);
  const results = document.createElement('div');
  results.className = 'sessions-checkbox-list morph-results';
  dialog.appendChild(results);

  // Footer.
  const btns = document.createElement('div');
  btns.className = 'morph-modal-buttons';
  const selInfo = document.createElement('span');
  selInfo.className = 'morph-modal-selinfo';
  btns.appendChild(selInfo);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sessions-filter-clear';
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'sessions-filter-clear morph-modal-apply';
  apply.textContent = 'Apply';
  btns.appendChild(cancel);
  btns.appendChild(apply);
  dialog.appendChild(btns);

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  cancel.addEventListener('click', close);

  function updateSelInfo() {
    selInfo.textContent = `${chosen.size} selected`;
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    if (chips.length === 0) { chipsEl.hidden = true; return; }
    chipsEl.hidden = false;
    chips.forEach((chip, i) => {
      const el = document.createElement('span');
      el.className = `morph-chip morph-chip-${chip.kind}`;
      const tag = document.createElement('span');
      tag.className = 'morph-chip-tag';
      tag.textContent = chip.kind === 'ccf' ? (chip.match === 'name' ? 'CCF area' : 'CCF') : 'text';
      el.appendChild(tag);
      const labelText = chip.kind === 'ccf' ? chip.acronym : chip.text;
      el.appendChild(document.createTextNode(' ' + labelText));
      if (chip.kind === 'ccf' && chip.name) el.title = chip.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'morph-chip-remove';
      x.title = 'Remove filter';
      x.textContent = '×';
      x.addEventListener('click', () => { chips.splice(i, 1); renderChips(); runSearch(); });
      el.appendChild(x);
      chipsEl.appendChild(el);
    });
  }

  function commitToken(text) {
    const chip = classifySearchToken(text, {
      acronymToNode: ctx.acronymToNode,
      nameToNode: ctx.nameToNode,
    });
    if (!chip) return;
    const dup = chips.some((c) =>
      c.kind === chip.kind &&
      (chip.kind === 'ccf'
        ? c.structureId === chip.structureId
        : c.text.toLowerCase() === chip.text.toLowerCase()));
    if (!dup) chips.push(chip);
    renderChips();
  }

  let pool = [];
  let mlLoading = false;

  async function ensurePool() {
    pool = [];
    if (scope === 'both' || scope === 'aind') pool.push(...ctx.aindNeurons);
    if (scope === 'both' || scope === 'ml') {
      if (!ctx.mlNeurons) {
        mlLoading = true;
        renderResults(null);
        try {
          ctx.mlNeurons = await ctx.getMlNeurons();
        } catch (e) {
          if (e?.name === 'AbortError') return;
          ctx.mlNeurons = [];
        } finally {
          mlLoading = false;
        }
      }
      pool.push(...(ctx.mlNeurons || []));
    }
  }

  let searchToken = 0;
  async function runSearch() {
    const token = ++searchToken;
    await ensurePool();
    if (token !== searchToken) return;

    const regionIds = chips.filter((c) => c.kind === 'ccf').map((c) => c.structureId);
    const keywords = chips.filter((c) => c.kind === 'keyword').map((c) => c.text);
    const live = search.value.trim();
    if (live) keywords.push(live);

    renderResults(filterNeurons(pool, { regionIds, keywords }));
  }

  function renderResults(matched) {
    results.innerHTML = '';
    if (matched === null) {
      resultsHead.textContent = 'Loading MouseLight…';
      const loadingEl = document.createElement('span');
      loadingEl.className = 'sessions-filter-empty';
      loadingEl.textContent = 'Loading MouseLight neuron list…';
      results.appendChild(loadingEl);
      return;
    }
    resultsHead.textContent =
      `${matched.length.toLocaleString()} matching neuron${matched.length === 1 ? '' : 's'}`;
    if (matched.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty';
      empty.textContent = 'No matching neurons';
      results.appendChild(empty);
      updateSelInfo();
      return;
    }
    const shown = matched.slice(0, 200);
    const frag = document.createDocumentFragment();
    for (const n of shown) {
      const row = document.createElement('label');
      row.className = 'sessions-checkbox-item morph-result-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = chosen.has(n.key);
      cb.addEventListener('change', () => {
        if (cb.checked) chosen.set(n.key, n);
        else chosen.delete(n.key);
        updateSelInfo();
      });
      row.appendChild(cb);

      const badge = document.createElement('span');
      badge.className = `morph-badge morph-badge-${n.dataset}`;
      badge.textContent = n.dataset === 'aind' ? 'AIND' : 'ML';
      row.appendChild(badge);

      const text = document.createElement('span');
      text.className = 'morph-panel-item-text';
      text.textContent = n.label;
      if (n.region) {
        const sub = document.createElement('span');
        sub.className = 'morph-panel-item-sub';
        sub.textContent = ' · ' + n.region;
        text.appendChild(sub);
      }
      row.appendChild(text);
      frag.appendChild(row);
    }
    results.appendChild(frag);
    if (matched.length > shown.length) {
      const more = document.createElement('span');
      more.className = 'sessions-filter-empty';
      more.textContent = `+${(matched.length - shown.length).toLocaleString()} more — refine search`;
      results.appendChild(more);
    }
    updateSelInfo();
  }

  const debouncedSearch = debounce(() => runSearch(), 200);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const t = search.value.trim();
      if (t) { commitToken(t); search.value = ''; }
      runSearch();
    } else if (e.key === 'Backspace' && search.value === '' && chips.length > 0) {
      chips.pop();
      renderChips();
      runSearch();
    }
  });
  search.addEventListener('input', debouncedSearch);

  apply.addEventListener('click', async () => {
    apply.disabled = true;
    apply.textContent = 'Applying…';
    let aborted = false;
    try {
      // AIND — segment ids render directly.
      ctx.selectedNeurons.clear();
      for (const item of chosen.values()) {
        if (item.dataset !== 'aind') continue;
        ctx.selectedNeurons.add(item.segmentId);
        if (!ctx.compartmentByNeuron.has(item.segmentId)) ctx.compartmentByNeuron.set(item.segmentId, 'full');
      }
      // MouseLight — fetch any missing skeletons before rendering. A single
      // neuron's fetch failing must not abort the whole apply, so each is
      // wrapped individually and the panel still refreshes below.
      ctx.selectedMouseLight.clear();
      for (const item of [...chosen.values()].filter((i) => i.dataset === 'ml')) {
        ctx.selectedMouseLight.add(item.idString);
        if (ctx.mlLayerCache.has(item.idString)) continue;
        try {
          const fetched = await fetchMouseLightTracings(item.tracings.map((t) => t.id), ctx.signal);
          const color = ctx.mlColorFor(item.idString);
          ctx.mlLayerCache.set(item.idString, buildMouseLightAnnotationLayer(item.idString, fetched, color));
        } catch (e) {
          if (e?.name === 'AbortError') { aborted = true; return; }
          console.warn('[exaspim-morph] MouseLight tracings fetch failed for', item.idString, e);
          ctx.selectedMouseLight.delete(item.idString);
        }
      }
      // Drop hidden flags for neurons that are no longer selected.
      for (const key of [...ctx.hiddenNeurons]) {
        if (!chosen.has(key)) ctx.hiddenNeurons.delete(key);
      }
    } finally {
      if (!aborted) {
        ctx.onChange();
        ctx.refreshPanel?.();
        close();
      }
    }
  });

  document.body.appendChild(overlay);
  renderChips();
  updateSelInfo();
  search.focus();
  runSearch();
}

// ─── Section factory ────────────────────────────────────────────────────────

/**
 * Build the Morphology viewer section. Returns the root element synchronously;
 * async data fills in once GraphQL fetches resolve.
 *
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {import('@uwdata/mosaic-core').Coordinator} [opts.coordinator]
 *   When provided, the MouseLight neuron list is read from the biodata-cache
 *   parquet via DuckDB (fast) instead of the Janelia GraphQL search.
 * @returns {HTMLElement}
 */
export function createExaSpimMorphologySection({ signal, coordinator } = {}) {
  const section = document.createElement('section');
  section.className = 'exaspim-morphology';

  // ── Initial view state from the URL ───────────────────────────────────────
  // Parsed up-front so the toggles render in the shared state and the 3D
  // camera is restored before the first Neuroglancer init. Selection params
  // (ccf/aind/ml) need the atlas + segment data, so they're read later.
  const initialUrlParams = new URLSearchParams(window.location.search);
  const initialView = initialUrlParams.get('view') === '2d' ? '2d' : '3d';
  const initialPlane = PLANE_KEYS.includes(initialUrlParams.get('plane'))
    ? initialUrlParams.get('plane')
    : 'sagittal';
  /** Latest known 3D camera — seeded from the URL, updated by the embed. */
  let currentCamera = decodeCamera(initialUrlParams.get('cam')) || DEFAULT_CAMERA;

  // Header
  const header = document.createElement('div');
  header.className = 'exaspim-morphology-header';
  const title = document.createElement('h3');
  title.className = 'platform-summary-heading';
  title.textContent = 'Neuron morphology viewer';
  header.appendChild(title);
  const portalLink = document.createElement('a');
  portalLink.className = 'exaspim-morphology-portal-link';
  portalLink.href = PORTAL_BASE + '/';
  portalLink.target = '_blank';
  portalLink.rel = 'noopener noreferrer';
  portalLink.textContent = 'Open external portal ↗';
  header.appendChild(portalLink);
  section.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'exaspim-morphology-body';
  section.appendChild(body);

  const controls = document.createElement('div');
  controls.className = 'exaspim-morphology-controls';
  body.appendChild(controls);

  const viewerCol = document.createElement('div');
  viewerCol.className = 'exaspim-morphology-viewer';
  body.appendChild(viewerCol);

  const linkBar = document.createElement('div');
  linkBar.className = 'exaspim-morphology-link-bar';
  viewerCol.appendChild(linkBar);

  // Left side: 3D / 2D mode toggle + (2D-only) projection-plane toggle.
  const leftControls = document.createElement('div');
  leftControls.className = 'exaspim-morphology-left-controls';
  linkBar.appendChild(leftControls);

  const modeToggle = document.createElement('div');
  modeToggle.className = 'morph-mode-toggle';
  const modeButtons = new Map();
  for (const m of [{ id: '3d', label: '3D' }, { id: '2d', label: '2D' }]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'morph-mode-opt';
    b.textContent = m.label;
    if (m.id === initialView) b.classList.add('active');
    b.addEventListener('click', () => setViewMode(m.id));
    modeButtons.set(m.id, b);
    modeToggle.appendChild(b);
  }
  leftControls.appendChild(modeToggle);

  const planeToggle = document.createElement('div');
  planeToggle.className = 'morph-plane-toggle';
  planeToggle.style.display = 'none';
  const planeButtons = new Map();
  for (const key of PLANE_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'morph-plane-opt';
    b.textContent = PLANES[key].label;
    if (key === initialPlane) b.classList.add('active');
    b.addEventListener('click', () => {
      plane2d = key;
      for (const [k, btn] of planeButtons) btn.classList.toggle('active', k === key);
      twoDFramed = false;
      update2D({ refit: true });
      syncUrlSelection();
    });
    planeButtons.set(key, b);
    planeToggle.appendChild(b);
  }
  leftControls.appendChild(planeToggle);

  // Right side: reset/fit + pop-out.
  const rightControls = document.createElement('div');
  rightControls.className = 'exaspim-morphology-right-controls';
  linkBar.appendChild(rightControls);
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'exaspim-morphology-reset-btn sessions-filter-clear';
  resetBtn.textContent = 'Reset view';
  resetBtn.title = 'Snap the camera back to the default CCF framing';
  rightControls.appendChild(resetBtn);
  const popoutLink = document.createElement('a');
  popoutLink.target = '_blank';
  popoutLink.rel = 'noopener noreferrer';
  popoutLink.className = 'exaspim-morphology-popout-link';
  popoutLink.textContent = 'Open in Neuroglancer ↗';
  rightControls.appendChild(popoutLink);

  // Wrap the iframe so we can lay a white cover over it: Neuroglancer paints a
  // black canvas during its own startup, then flips to our light background
  // once the init state lands. The cover hides that flash until we've applied
  // the first state.
  const frame = document.createElement('div');
  frame.className = 'exaspim-morphology-frame';
  viewerCol.appendChild(frame);

  const iframe = document.createElement('iframe');
  iframe.className = 'exaspim-morphology-iframe';
  iframe.setAttribute('title', 'Neuroglancer viewer');
  iframe.setAttribute('loading', 'lazy');
  // Same-origin self-hosted Neuroglancer (web/public/ng/). Loaded once;
  // subsequent updates go through postMessage so the camera is preserved.
  iframe.src = NEUROGLANCER_EMBED_PATH;
  frame.appendChild(iframe);

  const cover = document.createElement('div');
  cover.className = 'exaspim-morphology-cover';
  const coverText = document.createElement('span');
  coverText.className = 'exaspim-morphology-cover-text';
  coverText.textContent = 'Loading viewer…';
  cover.appendChild(coverText);
  frame.appendChild(cover);

  // Blocking overlay shown while a shared URL is being restored — in
  // particular while (slow) MouseLight skeletons load after the viewer has
  // already initialised, so the user knows more is still coming.
  const restoreOverlay = document.createElement('div');
  restoreOverlay.className = 'exaspim-morphology-restore-overlay';
  restoreOverlay.hidden = true;
  const restoreSpinner = document.createElement('div');
  restoreSpinner.className = 'exaspim-morphology-restore-spinner';
  restoreOverlay.appendChild(restoreSpinner);
  const restoreText = document.createElement('span');
  restoreText.className = 'exaspim-morphology-restore-text';
  restoreText.textContent = 'Restoring shared view…';
  restoreOverlay.appendChild(restoreText);
  frame.appendChild(restoreOverlay);
  const setRestoring = (on) => { restoreOverlay.hidden = !on; };

  // Fade the cover out shortly after the first state is applied, giving
  // Neuroglancer a beat to paint the light background underneath.
  let revealed = false;
  function revealViewer() {
    if (revealed) return;
    revealed = true;
    setTimeout(() => { cover.classList.add('is-hidden'); }, 350);
  }

  const selectedRegions = new Set();
  const selectedNeurons = new Set();
  /** Item keys (`aind:<seg>` / `ml:<idString>`) hidden from the viewer but kept
   *  in the selection so visibility can be toggled back on. */
  const hiddenNeurons = new Set();
  /** neuronId → 'full' | 'axon' | 'dendrite' */
  const compartmentByNeuron = new Map();
  /** CCF structure id (string) → Allen atlas CSS colour (e.g. "#ff4c3e"). */
  const ccfColorById = new Map();

  // MouseLight (Janelia) state. Selection is driven by the unified search
  // modal; the Both/AIND/MouseLight scope there is how users opt in or out.
  const selectedMouseLight = new Set();   // neuron idStrings
  const mlLayerCache = new Map();          // idString → NG annotation layer
  const mlColorByNeuron = new Map();       // idString → colour
  let mlColorCounter = 0;

  /** Assign (and remember) a distinct colour for a MouseLight neuron. */
  function mlColorFor(idString) {
    let c = mlColorByNeuron.get(idString);
    if (!c) { c = mouseLightColor(mlColorCounter++); mlColorByNeuron.set(idString, c); }
    return c;
  }

  /** Update a MouseLight neuron's colour and patch its cached annotation layer. */
  function setMlColor(idString, hex) {
    mlColorByNeuron.set(idString, hex);
    const layer = mlLayerCache.get(idString);
    if (layer) layer.annotationColor = hex;
  }

  // AIND neuron (precomputed segmentation) per-neuron colours.
  const aindColorBySegment = new Map();    // numeric segment id (string) → colour
  let aindColorCounter = 0;

  /** Assign (and remember) a distinct colour for an AIND neuron segment. */
  function aindColorFor(segmentId) {
    const key = String(segmentId);
    let c = aindColorBySegment.get(key);
    if (!c) { c = mouseLightColor(aindColorCounter++); aindColorBySegment.set(key, c); }
    return c;
  }

  // Buffer state updates until the iframe is ready, then drain.
  let ngReady = false;
  let initSent = false;
  let pendingState = null;

  function mouseLightLayers() {
    const layers = [];
    for (const id of selectedMouseLight) {
      if (hiddenNeurons.has('ml:' + id)) continue;
      const layer = mlLayerCache.get(id);
      if (layer) layers.push(layer);
    }
    return layers;
  }

  function buildCurrentState({ includeMouseLight = true, camera = currentCamera } = {}) {
    const neuronsByComp = { full: [], axon: [], dendrite: [] };
    const neuronColors = new Map();
    for (const id of selectedNeurons) {
      if (hiddenNeurons.has('aind:' + id)) continue;
      const comp = compartmentByNeuron.get(id) || 'full';
      (neuronsByComp[comp] ||= []).push(id);
      neuronColors.set(String(id), aindColorFor(id));
    }
    const extra = includeMouseLight ? mouseLightLayers() : [];
    return buildNgState([...selectedRegions], neuronsByComp, extra, camera, ccfColorById, neuronColors);
  }

  function postToIframe(message) {
    try {
      iframe.contentWindow?.postMessage(message, '*');
    } catch (e) {
      console.warn('[exaspim-morph] postMessage failed', e);
    }
  }

  // Listen for the embed-page ready signal + camera-state reports.
  window.addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const data = ev.data;
    if (data?.type === 'ng-ready') {
      ngReady = true;
      if (pendingState) {
        postToIframe({ type: 'init', state: pendingState });
        initSent = true;
        pendingState = null;
        revealViewer();
      }
    } else if (data?.type === 'ng-state' && Array.isArray(data.camera?.projectionOrientation)) {
      // The user moved the 3D camera — remember it and mirror it into the URL.
      currentCamera = {
        position: Array.isArray(data.camera.position) ? data.camera.position : currentCamera.position,
        projectionOrientation: data.camera.projectionOrientation,
        projectionScale: data.camera.projectionScale ?? currentCamera.projectionScale,
        crossSectionScale: data.camera.crossSectionScale ?? currentCamera.crossSectionScale,
      };
      syncUrlSelection();
    }
  });

  const updateIframe = debounce(() => {
    const state = buildCurrentState();
    // Keep the pop-out link in sync. MouseLight skeletons are embedded as
    // (potentially huge) local annotation layers, so we exclude them here to
    // keep the shareable URL within browser length limits.
    popoutLink.href = buildNgUrl(buildCurrentState({ includeMouseLight: false }));
    if (!ngReady) {
      pendingState = state;
      return;
    }
    if (!initSent) {
      // First update after the viewer mounted: we MUST send the full state so
      // the layout (3d), dimensions (10µm), background colors and camera all
      // take effect — sending only `setLayers` here would leave the viewer
      // stuck on Neuroglancer's default 4-panel/1µm layout.
      postToIframe({ type: 'init', state });
      initSent = true;
      revealViewer();
      return;
    }
    // Subsequent updates only swap layers — the embed merges them onto the
    // current viewer state so the camera the user moved to is preserved.
    postToIframe({ type: 'setLayers', layers: state.layers });
  }, 250);

  // ── 2D projection view ────────────────────────────────────────────────────
  const view2d = createProjection2DView();
  view2d.el.style.display = 'none';
  frame.appendChild(view2d.el);

  let viewMode = '3d';
  let plane2d = initialPlane;
  let twoDFramed = false;
  let twoDToken = 0;
  let ctxRef = null;
  const mlNodeCache = new Map(); // idString → {vertices, edges} (µm)

  function mlItemFor(idString) {
    for (const it of ctxRef?.mlNeurons || []) if (it.idString === idString) return it;
    return null;
  }

  // Rebuild the 2D projection from the current selection. Token-guarded so a
  // newer call (plane switch / selection change) wins over an in-flight one.
  async function update2D({ refit = false } = {}) {
    if (viewMode !== '2d') return;
    const token = ++twoDToken;
    const planeKey = plane2d;
    const plane = PLANES[planeKey];
    view2d.setStatus('Building projection…');
    const items = [];

    // CCF area outlines (black for the whole-brain root, else atlas colour).
    for (const id of selectedRegions) {
      let segs;
      try { segs = await getCcfOutlineSegments(id, planeKey, signal); }
      catch (e) { if (e?.name === 'AbortError') return; continue; }
      if (token !== twoDToken) return;
      const isRoot = String(id) === CCF_ROOT_SEGMENT;
      const color = isRoot ? '#111111' : (ccfColorById.get(String(id)) || '#111111');
      items.push({ positions: segs, color, opacity: isRoot ? 0.5 : 0.85, lineWidth: 3 });
    }

    // AIND neuron skeletons (honour the per-neuron compartment selection).
    for (const segId of selectedNeurons) {
      if (hiddenNeurons.has('aind:' + segId)) continue;
      const comp = compartmentByNeuron.get(segId) || 'full';
      let skel;
      try { skel = await loadAindSkeleton(segId, comp, signal); }
      catch (e) { if (e?.name === 'AbortError') return; continue; }
      if (token !== twoDToken) return;
      items.push({ positions: projectEdgesToSegments(skel.vertices, skel.edges, plane), color: aindColorFor(segId) });
    }

    // MouseLight neuron skeletons (fetch raw µm nodes once, cache per neuron).
    if (selectedMouseLight.size > 0 && !ctxRef?.mlNeurons && ctxRef?.getMlNeurons) {
      try { ctxRef.mlNeurons = await ctxRef.getMlNeurons(); }
      catch (e) { if (e?.name === 'AbortError') return; }
    }
    for (const idString of selectedMouseLight) {
      if (hiddenNeurons.has('ml:' + idString)) continue;
      let skel = mlNodeCache.get(idString);
      if (!skel) {
        const item = mlItemFor(idString);
        if (!item) continue;
        let tr;
        try { tr = await fetchMouseLightTracings(item.tracings.map((t) => t.id), signal); }
        catch (e) { if (e?.name === 'AbortError') return; continue; }
        skel = tracingsToSkeleton(tr);
        mlNodeCache.set(idString, skel);
      }
      if (token !== twoDToken) return;
      items.push({ positions: projectEdgesToSegments(skel.vertices, skel.edges, plane), color: mlColorFor(idString) });
    }

    if (token !== twoDToken) return;
    view2d.render(items);
    view2d.setStatus(items.length === 0 ? 'Select CCF regions or neurons to project.' : '');
    if (refit || !twoDFramed) {
      const b = boundsOfItems(items);
      if (b) { view2d.frameBounds(b); twoDFramed = true; }
    }
  }

  // Route selection/colour/visibility changes to whichever view is active.
  function refreshView() {
    syncUrlSelection();
    if (viewMode === '2d') update2D();
    else updateIframe();
  }

  // Mirror the full shareable view state into the page URL: selected CCF
  // regions (?ccf), AIND/MouseLight neurons (?aind/?ml), the 2D/3D mode
  // (?view), the 2D plane (?plane) and the 3D camera (?cam). Redundant writes
  // are skipped by comparing the resulting URL string — so colour/compartment
  // tweaks (which also fire onChange) and no-op camera reports don't spam
  // history.replaceState, keeping us under Firefox's History API rate limit.
  let lastSyncedUrl = null;
  function syncUrlSelection() {
    try {
      const params = new URLSearchParams(window.location.search);
      const setOrDelete = (key, val) => { if (val) params.set(key, val); else params.delete(key); };
      setOrDelete('ccf', [...selectedRegions].join(','));
      setOrDelete('aind', [...selectedNeurons].join(','));
      setOrDelete('ml', [...selectedMouseLight].join(','));
      params.set('view', viewMode);
      params.set('plane', plane2d);
      const camStr = encodeCamera(currentCamera);
      setOrDelete('cam', camStr && camStr !== encodeCamera(DEFAULT_CAMERA) ? camStr : '');
      const qs = params.toString();
      const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
      if (url === lastSyncedUrl) return;
      lastSyncedUrl = url;
      history.replaceState(history.state, '', url);
    } catch (_) { /* URL sync is best-effort */ }
  }

  function setViewMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    for (const [id, btn] of modeButtons) btn.classList.toggle('active', id === mode);
    const is2d = mode === '2d';
    iframe.style.display = is2d ? 'none' : '';
    cover.style.display = is2d ? 'none' : '';
    view2d.el.style.display = is2d ? '' : 'none';
    planeToggle.style.display = is2d ? '' : 'none';
    popoutLink.style.display = is2d ? 'none' : '';
    resetBtn.textContent = is2d ? 'Fit view' : 'Reset view';
    resetBtn.title = is2d
      ? 'Fit the projection to the view'
      : 'Snap the camera back to the default CCF framing';
    if (is2d) {
      // Wait one frame so the now-visible canvas reports a real size before we
      // size the renderer and fit the projection to it.
      requestAnimationFrame(() => {
        view2d.resize();
        update2D({ refit: true });
      });
    } else {
      updateIframe();
    }
    syncUrlSelection();
  }

  resetBtn.addEventListener('click', () => {
    if (viewMode === '2d') {
      twoDFramed = false;
      update2D({ refit: true });
      return;
    }
    // Snap the 3D camera back to the default CCF framing and reflect that in
    // the URL (drop the ?cam param).
    currentCamera = DEFAULT_CAMERA;
    const state = buildCurrentState({ camera: DEFAULT_CAMERA });
    syncUrlSelection();
    if (!ngReady) { pendingState = state; return; }
    postToIframe({ type: 'resetView', state });
    initSent = true;
  });

  Promise.all([
    gql(ATLAS_QUERY, {}, signal).then((d) => d?.atlasStructures ?? []),
    fetch(NEURON_SEG_PROPS_URL, { signal })
      .then((r) => { if (!r.ok) throw new Error(`segment_properties HTTP ${r.status}`); return r.json(); })
      .catch(() => null),
  ]).then(([atlas, segInfo]) => {
    const { roots, byId } = buildAtlasTree(atlas);

    // Build the CCF id → Allen atlas colour lookup so checked regions render
    // in their true colours (defaultColor is a hex string without '#').
    ccfColorById.clear();
    for (const node of byId.values()) {
      if (node.color) ccfColorById.set(String(node.id), '#' + node.color);
    }

    // Lowercase-keyed acronym / area-name lookups power the unified search
    // (exact CCF matches → chips) and hierarchical region filtering.
    const acronymToNode = new Map();
    const nameToNode = new Map();
    for (const node of byId.values()) {
      if (node.acronym) acronymToNode.set(node.acronym.toLowerCase(), node);
      if (node.name) nameToNode.set(node.name.toLowerCase(), node);
    }

    // Only the ~131 currently-published neurons have numeric segment ids that
    // Neuroglancer can render; segment_properties gives us their label + soma
    // region directly, so AIND search runs entirely client-side.
    const segments = segInfo ? parseSegmentProperties(segInfo) : [];
    const aindNeurons = segments.map((s) =>
      makeNeuronItem('aind', { label: s.label, segmentId: s.id, region: s.region }, acronymToNode, byId));

    // Restore selection + view state from the URL. We always write `view`
    // (and `plane`) when syncing, so the presence of any of our params marks
    // this as an explicit shared link — in which case we restore EXACTLY what
    // it encodes (respecting deliberately-empty selections) rather than adding
    // the bare-URL defaults (whole-brain root + first 5 neurons).
    const urlParams = new URLSearchParams(window.location.search);
    const splitParam = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isSharedUrl = ['ccf', 'aind', 'ml', 'view', 'plane', 'cam'].some((k) => urlParams.has(k));

    // CCF regions: restore from URL, else default-on the whole-brain root (997).
    const urlCcf = splitParam(urlParams.get('ccf')).filter((id) => byId.has(String(id)));
    for (const id of urlCcf) selectedRegions.add(String(id));
    if (!isSharedUrl && byId.has('997')) selectedRegions.add('997');

    // Neurons: AIND ids render immediately; MouseLight ids restore async below.
    const validAindIds = new Set(segments.map((s) => String(s.id)));
    const urlAind = splitParam(urlParams.get('aind')).filter((id) => validAindIds.has(id));
    const urlMl = splitParam(urlParams.get('ml'));
    for (const id of urlAind) selectedNeurons.add(id);
    if (!isSharedUrl) {
      for (const s of segments.slice(0, 5)) selectedNeurons.add(s.id);
    }

    // Lazily fetch + map the MouseLight neuron list the first time the user
    // searches MouseLight (or "Both"). Cached for the page's lifetime.
    let mlNeuronsPromise = null;
    function getMlNeurons() {
      if (!mlNeuronsPromise) {
        // Prefer the fast biodata-cache parquet (DuckDB); fall back to the slow
        // Janelia GraphQL search if no coordinator is available.
        const rawPromise = coordinator
          ? fetchMouseLightNeuronsCached(coordinator)
          : fetchMouseLightNeurons(signal);
        mlNeuronsPromise = rawPromise.then((raw) =>
          raw.map((n) => makeNeuronItem('ml', {
            label: n.idString, idString: n.idString, region: n.region, tracings: n.tracings,
          }, acronymToNode, byId)));
      }
      return mlNeuronsPromise;
    }

    const ctx = {
      byId, acronymToNode, nameToNode,
      aindNeurons,
      mlNeurons: null,
      getMlNeurons,
      mlColorFor,
      selectedNeurons, compartmentByNeuron, hiddenNeurons,
      selectedMouseLight, mlLayerCache, mlColorByNeuron,
      colorOf: (n) => (n.dataset === 'aind' ? aindColorFor(n.segmentId) : mlColorFor(n.idString)),
      setColor: (n, hex) => {
        if (n.dataset === 'aind') aindColorBySegment.set(String(n.segmentId), hex);
        else setMlColor(n.idString, hex);
      },
      onChange: refreshView,
      refreshPanel: null,
      signal,
    };
    ctxRef = ctx;

    const regionPanel = buildTreePanel({
      title: 'CCF regions',
      roots,
      selected: selectedRegions,
      onChange: refreshView,
      defaultOpenDepth: 2,
    });
    controls.appendChild(regionPanel);

    const neuronPanel = buildNeuronPanel(ctx);
    controls.appendChild(neuronPanel);

    // Show the blocking spinner up-front when a shared link includes (slow)
    // MouseLight neurons, then apply the initial 2D/3D mode and kick off the
    // first viewer render.
    if (urlMl.length > 0) setRestoring(true);
    updateIframe();
    setViewMode(initialView);

    // Restore any MouseLight neurons named in the URL. Needs the ML neuron list
    // (to resolve idStrings → tracing ids) plus a skeleton fetch per neuron, so
    // it runs asynchronously after the initial render and refreshes once ready.
    if (urlMl.length > 0) {
      (async () => {
        try {
          let mlList;
          try {
            mlList = await getMlNeurons();
          } catch (e) {
            if (e?.name === 'AbortError') return;
            return;
          }
          ctx.mlNeurons = mlList;
          const mlById = new Map(mlList.map((it) => [it.idString, it]));
          let added = false;
          for (const idString of urlMl) {
            const item = mlById.get(idString);
            if (!item) continue;
            selectedMouseLight.add(item.idString);
            if (!mlLayerCache.has(item.idString)) {
              try {
                const fetched = await fetchMouseLightTracings(item.tracings.map((t) => t.id), signal);
                mlLayerCache.set(item.idString, buildMouseLightAnnotationLayer(item.idString, fetched, mlColorFor(item.idString)));
              } catch (e) {
                if (e?.name === 'AbortError') return;
                selectedMouseLight.delete(item.idString);
                continue;
              }
            }
            added = true;
          }
          if (added) {
            ctx.refreshPanel?.();
            refreshView();
          }
        } finally {
          setRestoring(false);
        }
      })();
    }
  }).catch((err) => {
    if (err?.name === 'AbortError') return;
    console.error('[exaspim-morph] Failed to load morphology data:', err);
    revealViewer();
  });

  return section;
}
