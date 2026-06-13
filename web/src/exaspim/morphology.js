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
 *     clear), and a neuron search panel (settings gear opens a modal for
 *     region/keyword filters; per-neuron compartment dropdown switches
 *     full ↔ axon ↔ dendrite).
 *   - Right column: the Neuroglancer iframe.
 *
 * State sync: we write the iframe `src` with the same base host and only the
 * URL fragment differs between updates. Browsers treat this as a fragment
 * navigation (hashchange) without document reload, and Neuroglancer keeps the
 * camera position because we don't include position/projectionScale/etc in
 * the state we send.
 */

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

// ─── GraphQL ────────────────────────────────────────────────────────────────

const ATLAS_QUERY = `query CcfStructures {
  atlasStructures {
    id name acronym structureId parentStructureId
    structureIdPath defaultColor hasGeometry
  }
}`;

const SYSTEM_QUERY = `query SystemMeta {
  systemSettings { systemVersion neuronCount }
}`;

const CANDIDATE_NEURONS_QUERY = `query CandidateNeurons($input: NeuronQueryInput) {
  candidateNeurons(input: $input) {
    totalCount
    items {
      id
      label
      atlasStructure { id structureId acronym name }
    }
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
 */
export function buildNgState(
  ccfSegments,
  neuronsByComp = { full: [], axon: [], dendrite: [] },
  camera = DEFAULT_CAMERA,
) {
  const layers = [
    {
      type: 'segmentation',
      source: CCF_SOURCE,
      name: 'ccf',
      objectAlpha: 0.18,
      segments: ccfSegments.map(String),
      meshSilhouetteRendering: 3,
    },
  ];
  for (const comp of COMPARTMENTS) {
    const ids = neuronsByComp?.[comp] ?? [];
    if (ids.length === 0) continue;
    layers.push({
      type: 'segmentation',
      source: NEURON_SOURCES[comp],
      name: comp === 'full' ? 'neurons' : `neurons-${comp}`,
      segments: ids.map(String),
      skeletonRendering: { mode2d: 'lines_and_points', lineWidth3d: 2 },
    });
  }
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

/**
 * Neuron search panel: lists matching neurons, per-row checkbox + compartment
 * dropdown, with a settings-gear button opening a filter modal.
 *
 * @param {object} opts
 * @param {Set<string>} opts.selected     Mutated in place (set of neuron ids).
 * @param {Map<string,string>} opts.compartmentByNeuron  Mutated in place.
 * @param {Map<string,{id,structureId,acronym}>} opts.atlasById  Lookup for
 *   resolving CCF structureIds (numeric strings) → portal UUIDs.
 * @param {() => void} opts.onChange
 * @param {AbortSignal} [opts.signal]
 */
function buildNeuronSearchPanel({
  selected,
  compartmentByNeuron,
  atlasById,
  labelToSegmentId,
  onChange,
  signal,
}) {
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

  // Filter summary + gear
  const filterBar = document.createElement('div');
  filterBar.className = 'morph-filter-bar';
  const filterSummary = document.createElement('span');
  filterSummary.className = 'morph-filter-summary';
  filterSummary.textContent = 'All neurons';
  filterBar.appendChild(filterSummary);
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'morph-gear-btn';
  gear.title = 'Edit filters';
  gear.textContent = '⚙';
  filterBar.appendChild(gear);
  panel.appendChild(filterBar);

  // Inline search (label / id)
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Filter by label…';
  search.className = 'smartspim-subject-search morph-panel-search';
  panel.appendChild(search);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'morph-panel-actions';
  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'sessions-filter-clear';
  selectAllBtn.textContent = 'Select shown';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'sessions-filter-clear';
  clearBtn.textContent = 'Clear';
  actions.appendChild(selectAllBtn);
  actions.appendChild(clearBtn);
  panel.appendChild(actions);

  // List
  const list = document.createElement('div');
  list.className = 'sessions-checkbox-list morph-panel-list';
  panel.appendChild(list);

  // ── Filter state ─────────────────────────────────────────────────────
  /** @type {{regionIds:string[], keyword:string, limit:number}} */
  const filter = {
    /** numeric CCF structure ids (we resolve to UUIDs at query time) */
    regionIds: [],
    keyword: '',
    limit: 50,
  };
  let lastResults = []; // [{uuid, segmentId|null, label, region, regionId}]
  let totalCount = 0;
  let loading = false;
  let error = null;

  function updateCount() {
    if (loading) count.textContent = '…';
    else if (error) count.textContent = '!';
    else count.textContent = `${selected.size} / ${totalCount.toLocaleString()}`;
  }

  function updateFilterSummary() {
    const parts = [];
    if (filter.regionIds.length > 0) {
      const names = filter.regionIds
        .map((id) => atlasById?.get(String(id))?.acronym || id)
        .slice(0, 3)
        .join(', ');
      const extra = filter.regionIds.length > 3 ? ` +${filter.regionIds.length - 3}` : '';
      parts.push(`region: ${names}${extra}`);
    }
    if (filter.keyword) parts.push(`kw: "${filter.keyword}"`);
    filterSummary.textContent = parts.length === 0 ? 'All neurons' : parts.join(' · ');
  }

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const visible = q
      ? lastResults.filter(
          (n) =>
            (n.label || '').toLowerCase().includes(q) ||
            (n.region || '').toLowerCase().includes(q),
        )
      : lastResults;
    list.innerHTML = '';
    if (loading) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty';
      empty.textContent = 'Loading…';
      list.appendChild(empty);
      return;
    }
    if (error) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty error';
      empty.textContent = `Error: ${error}`;
      list.appendChild(empty);
      return;
    }
    if (visible.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'sessions-filter-empty';
      empty.textContent = 'No matching neurons';
      list.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const n of visible) {
      const renderable = !!n.segmentId;
      const row = document.createElement('label');
      row.className = 'sessions-checkbox-item morph-neuron-row';
      if (!renderable) row.classList.add('morph-neuron-row-disabled');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = n.segmentId ?? '';
      cb.disabled = !renderable;
      cb.checked = renderable && selected.has(n.segmentId);
      if (!renderable) cb.title = 'Not yet published to the precomputed segmentation';
      cb.addEventListener('change', () => {
        if (!renderable) return;
        if (cb.checked) {
          selected.add(n.segmentId);
          if (!compartmentByNeuron.has(n.segmentId)) compartmentByNeuron.set(n.segmentId, 'full');
        } else {
          selected.delete(n.segmentId);
        }
        updateCount();
        onChange();
      });
      row.appendChild(cb);

      const text = document.createElement('span');
      text.className = 'morph-panel-item-text';
      text.textContent = n.label || n.uuid;
      if (n.region) {
        const sub = document.createElement('span');
        sub.className = 'morph-panel-item-sub';
        sub.textContent = ' · ' + n.region;
        text.appendChild(sub);
      }
      if (!renderable) {
        const sub = document.createElement('span');
        sub.className = 'morph-panel-item-sub';
        sub.textContent = ' (no mesh)';
        text.appendChild(sub);
      }
      row.appendChild(text);

      const sel = document.createElement('select');
      sel.className = 'morph-compartment-select';
      sel.title = 'Display compartment';
      sel.disabled = !renderable;
      for (const c of COMPARTMENTS) {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        sel.appendChild(opt);
      }
      sel.value = (renderable && compartmentByNeuron.get(n.segmentId)) || 'full';
      sel.addEventListener('click', (e) => e.preventDefault());
      sel.addEventListener('change', () => {
        if (!renderable) return;
        compartmentByNeuron.set(n.segmentId, sel.value);
        if (selected.has(n.segmentId)) onChange();
      });
      row.appendChild(sel);

      frag.appendChild(row);
    }
    list.appendChild(frag);
  }

  // ── Query ────────────────────────────────────────────────────────────
  let queryToken = 0;
  async function runQuery() {
    const token = ++queryToken;
    loading = true; error = null; updateCount(); renderList();
    try {
      // Resolve numeric CCF structure ids → portal UUIDs (what the API wants).
      const atlasUuids = filter.regionIds
        .map((id) => atlasById?.get(String(id))?.uuid)
        .filter(Boolean);
      const input = {
        offset: 0,
        limit: filter.limit,
        specimenIds: [],
        atlasStructureIds: atlasUuids,
        keywords: filter.keyword ? [filter.keyword] : [],
        somaProperties: null,
      };
      const data = await gql(CANDIDATE_NEURONS_QUERY, { input }, signal);
      if (token !== queryToken) return;
      const items = data?.candidateNeurons?.items ?? [];
      totalCount = data?.candidateNeurons?.totalCount ?? items.length;
      lastResults = items.map((n) => {
        const label = n.label || '';
        const segmentId = labelToSegmentId?.get(label) ?? null;
        return {
          uuid: n.id,
          segmentId,
          label,
          region: n.atlasStructure?.acronym || '',
          regionId: n.atlasStructure?.structureId ?? null,
        };
      });
      loading = false;
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (token !== queryToken) return;
      loading = false;
      error = e?.message ?? String(e);
    }
    updateCount(); renderList();
  }

  // ── Settings modal ───────────────────────────────────────────────────
  function openModal() {
    const overlay = document.createElement('div');
    overlay.className = 'morph-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'morph-modal';
    overlay.appendChild(dialog);

    const h = document.createElement('h4');
    h.textContent = 'Neuron search filters';
    h.className = 'morph-modal-title';
    dialog.appendChild(h);

    // Region multi-select (acronym tokens)
    const regLabel = document.createElement('label');
    regLabel.className = 'morph-modal-label';
    regLabel.textContent = 'Brain regions (CCF acronyms, comma-separated)';
    dialog.appendChild(regLabel);
    const regInput = document.createElement('input');
    regInput.type = 'text';
    regInput.className = 'morph-modal-input';
    regInput.placeholder = 'e.g. VISp, CA1, MOs';
    regInput.value = filter.regionIds
      .map((id) => atlasById?.get(String(id))?.acronym || id)
      .join(', ');
    dialog.appendChild(regInput);

    // Keyword
    const kwLabel = document.createElement('label');
    kwLabel.className = 'morph-modal-label';
    kwLabel.textContent = 'Keyword (label match)';
    dialog.appendChild(kwLabel);
    const kwInput = document.createElement('input');
    kwInput.type = 'text';
    kwInput.className = 'morph-modal-input';
    kwInput.placeholder = 'e.g. N004';
    kwInput.value = filter.keyword;
    dialog.appendChild(kwInput);

    // Limit
    const limLabel = document.createElement('label');
    limLabel.className = 'morph-modal-label';
    limLabel.textContent = 'Result limit';
    dialog.appendChild(limLabel);
    const limInput = document.createElement('input');
    limInput.type = 'number';
    limInput.min = '1';
    limInput.max = '500';
    limInput.className = 'morph-modal-input';
    limInput.value = String(filter.limit);
    dialog.appendChild(limInput);

    // Buttons
    const btns = document.createElement('div');
    btns.className = 'morph-modal-buttons';
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
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    cancel.addEventListener('click', close);
    apply.addEventListener('click', () => {
      // Resolve acronym tokens → numeric structureIds.
      const tokens = regInput.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const newRegionIds = [];
      if (atlasById) {
        const acroToId = new Map();
        for (const n of atlasById.values()) {
          if (n.acronym) acroToId.set(n.acronym.toLowerCase(), n.id);
        }
        for (const t of tokens) {
          if (/^\d+$/.test(t)) newRegionIds.push(t);
          else {
            const id = acroToId.get(t.toLowerCase());
            if (id) newRegionIds.push(id);
          }
        }
      }
      filter.regionIds = newRegionIds;
      filter.keyword = kwInput.value.trim();
      const lim = Number(limInput.value);
      filter.limit = Number.isFinite(lim) && lim > 0 ? Math.min(500, Math.floor(lim)) : 50;
      updateFilterSummary();
      close();
      runQuery();
    });

    document.body.appendChild(overlay);
    regInput.focus();
  }

  gear.addEventListener('click', openModal);
  search.addEventListener('input', renderList);
  selectAllBtn.addEventListener('click', () => {
    for (const n of lastResults) {
      if (!n.segmentId) continue;
      selected.add(n.segmentId);
      if (!compartmentByNeuron.has(n.segmentId)) compartmentByNeuron.set(n.segmentId, 'full');
    }
    renderList();
    updateCount();
    onChange();
  });
  clearBtn.addEventListener('click', () => {
    selected.clear();
    renderList();
    updateCount();
    onChange();
  });

  // Kick off initial query.
  runQuery();
  updateFilterSummary();
  updateCount();
  return panel;
}

// ─── Section factory ────────────────────────────────────────────────────────

/**
 * Build the Morphology viewer section. Returns the root element synchronously;
 * async data fills in once GraphQL fetches resolve.
 *
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {HTMLElement}
 */
export function createExaSpimMorphologySection({ signal } = {}) {
  const section = document.createElement('section');
  section.className = 'exaspim-morphology';

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

  const summary = document.createElement('div');
  summary.className = 'exaspim-morphology-summary';
  summary.textContent = 'Loading morphology data…';
  section.appendChild(summary);

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
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'exaspim-morphology-reset-btn sessions-filter-clear';
  resetBtn.textContent = 'Reset view';
  resetBtn.title = 'Snap the camera back to the default CCF framing';
  linkBar.appendChild(resetBtn);
  const popoutLink = document.createElement('a');
  popoutLink.target = '_blank';
  popoutLink.rel = 'noopener noreferrer';
  popoutLink.className = 'exaspim-morphology-popout-link';
  popoutLink.textContent = 'Open in Neuroglancer ↗';
  linkBar.appendChild(popoutLink);

  const iframe = document.createElement('iframe');
  iframe.className = 'exaspim-morphology-iframe';
  iframe.setAttribute('title', 'Neuroglancer viewer');
  iframe.setAttribute('loading', 'lazy');
  // Same-origin self-hosted Neuroglancer (web/public/ng/). Loaded once;
  // subsequent updates go through postMessage so the camera is preserved.
  iframe.src = NEUROGLANCER_EMBED_PATH;
  viewerCol.appendChild(iframe);

  const selectedRegions = new Set();
  const selectedNeurons = new Set();
  /** neuronId → 'full' | 'axon' | 'dendrite' */
  const compartmentByNeuron = new Map();

  // Buffer state updates until the iframe is ready, then drain.
  let ngReady = false;
  let initSent = false;
  let pendingState = null;

  function buildCurrentState() {
    const neuronsByComp = { full: [], axon: [], dendrite: [] };
    for (const id of selectedNeurons) {
      const comp = compartmentByNeuron.get(id) || 'full';
      (neuronsByComp[comp] ||= []).push(id);
    }
    return buildNgState([...selectedRegions], neuronsByComp);
  }

  function postToIframe(message) {
    try {
      iframe.contentWindow?.postMessage(message, '*');
    } catch (e) {
      console.warn('[exaspim-morph] postMessage failed', e);
    }
  }

  // Listen for the embed-page ready signal.
  window.addEventListener('message', (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    if (ev.data?.type === 'ng-ready') {
      ngReady = true;
      if (pendingState) {
        postToIframe({ type: 'init', state: pendingState });
        initSent = true;
        pendingState = null;
      }
    }
  });

  const updateIframe = debounce(() => {
    const state = buildCurrentState();
    // Keep the pop-out link in sync (encodes full state into the public NG demo
    // URL so the user can share or open the exact view in a tab).
    popoutLink.href = buildNgUrl(state);
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
      return;
    }
    // Subsequent updates only swap layers — the embed merges them onto the
    // current viewer state so the camera the user moved to is preserved.
    postToIframe({ type: 'setLayers', layers: state.layers });
  }, 250);

  resetBtn.addEventListener('click', () => {
    const state = buildCurrentState();
    if (!ngReady) { pendingState = state; return; }
    postToIframe({ type: 'resetView', state });
    initSent = true;
  });

  Promise.all([
    gql(ATLAS_QUERY, {}, signal).then((d) => d?.atlasStructures ?? []),
    gql(SYSTEM_QUERY, {}, signal).then((d) => d?.systemSettings ?? {}).catch(() => ({})),
    fetch(NEURON_SEG_PROPS_URL, { signal })
      .then((r) => { if (!r.ok) throw new Error(`segment_properties HTTP ${r.status}`); return r.json(); })
      .catch(() => null),
  ]).then(([atlas, sys, segInfo]) => {
    const { roots, byId } = buildAtlasTree(atlas);
    const geomCount = [...byId.values()].filter((n) => n.hasGeometry).length;
    const published = sys?.neuronCount ?? 0;

    // Build label → numeric-segment-id map from segment_properties (only the
    // ~131 currently-published neurons have numeric segment ids that NG can
    // actually render). Used by the search panel to join GraphQL labels to
    // renderable segment ids.
    const segments = segInfo ? parseSegmentProperties(segInfo) : [];
    const labelToSegmentId = new Map();
    for (const s of segments) {
      if (s.label) labelToSegmentId.set(s.label, s.id);
    }

    summary.innerHTML =
      `<strong>${geomCount.toLocaleString()}</strong> CCF regions with geometry · ` +
      `<strong>${segments.length.toLocaleString()}</strong> neurons with published meshes ` +
      `(of <strong>${published.toLocaleString()}</strong> total in the portal)` +
      (sys?.systemVersion ? ` · portal v${sys.systemVersion}` : '');

    // Default-on root region (root brain, structureId 997).
    if (byId.has('997')) selectedRegions.add('997');
    // Default-on: first 5 published neurons so the viewer isn't empty.
    for (const s of segments.slice(0, 5)) selectedNeurons.add(s.id);

    const regionPanel = buildTreePanel({
      title: 'CCF regions',
      roots,
      selected: selectedRegions,
      onChange: updateIframe,
      defaultOpenDepth: 2,
    });
    controls.appendChild(regionPanel);

    const neuronPanel = buildNeuronSearchPanel({
      selected: selectedNeurons,
      compartmentByNeuron,
      atlasById: byId,
      labelToSegmentId,
      onChange: updateIframe,
      signal,
    });
    controls.appendChild(neuronPanel);

    updateIframe();
  }).catch((err) => {
    if (err?.name === 'AbortError') return;
    summary.className = 'exaspim-morphology-summary error';
    summary.textContent = `Failed to load morphology data: ${err?.message ?? err}`;
  });

  return section;
}
