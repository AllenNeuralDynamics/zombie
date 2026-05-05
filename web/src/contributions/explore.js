/**
 * explore.js — Network "Explore" view for the Contributions preview.
 *
 * A force-directed author collaboration graph where:
 *   - Nodes are authors (colored-initials avatars; photo-ready via author.avatar_url)
 *   - Edges are per-role colored strands between authors who share a CRediT role
 *   - Institutional affiliation drives a hidden clustering force (no visible hulls)
 *   - Left sidebar: CRediT role legend — hover to spotlight authors with that role
 *   - Right sidebar: Affiliation legend — hover to spotlight authors from that institution
 *   - Edges are faded by default; they light up on node/role/affiliation hover
 *
 * Exported: createExploreView(container, authors) → cleanup function
 * To disable: comment out the import and tab wiring in preview.js.
 */

// ── Simulation constants ──────────────────────────────────────────────────────

const _NS  = 'http://www.w3.org/2000/svg';
const _NR  = 26;     // node radius (px)
const _CH  = 560;    // canvas height (px) — visible viewport
const _WW  = 1400;   // simulation world width (px) — larger than viewport so nodes spread out
const _WH  = 1100;   // simulation world height (px)
const _SIM = 520;    // simulation steps
const _DAMP = 0.80;  // velocity damping per step
const _REP  = 9000;  // charge repulsion strength (higher = more spread)
const _SK   = 0.022; // spring constant (lower = looser springs)
const _SR   = 240;   // spring rest length base (px)
const _CK   = 0.030; // cluster gravity strength (lower = softer clustering)
const _GK   = 0.006; // global center gravity strength
const _CGAP = 3.5;   // gap between parallel edge strands (px)
const _PAD  = _NR + 70; // canvas boundary padding (room for label)

// Zoom constants
const _ZOOM_WHEEL_SENSITIVITY = 0.0008; // multiplicative factor per deltaY unit (lower = slower)
const _ZOOM_BTN_FACTOR        = 1.30;   // multiply/divide scale per button click

// ── CRediT taxonomy ───────────────────────────────────────────────────────────

const _ROLES = [
  'Conceptualization', 'Methodology', 'Software', 'Validation',
  'Formal analysis', 'Investigation', 'Resources', 'Data curation',
  'Writing \u2013 original draft', 'Writing \u2013 review & editing',
  'Visualization', 'Supervision', 'Project Administration', 'Funding Acquisition',
];

// ── CRediT role colors — Allen Institute palette, three semantic groups ─────
//
// Group 1 · Leadership  (Primary 1 #4D66FF + Primary 2 #7333FF family)
// Group 2 · Data        (Primary 4 #00FF99 family, toned for screen)
// Group 3 · Analysis    (Primary 3 #D90078 family)
//
const _ROLE_COLOR = {
  // ── Group 1: Leadership (blue-violet → purple) ──────────────────────────
  'Conceptualization':                '#4466FF',  // Primary 1, bright blue-violet
  'Supervision':                      '#6644EE',  // mid blue-purple
  'Project Administration':           '#8833CC',  // violet-purple, near Primary 2
  'Funding Acquisition':              '#4455BB',  // darker indigo-blue

  // ── Group 2: Data acquisition (green → teal-cyan) ───────────────────────
  'Methodology':                      '#00BB55',  // vibrant green
  'Validation':                       '#009950',  // medium-dark green
  'Investigation':                    '#00AA88',  // teal-green
  'Resources':                        '#0099BB',  // teal-blue
  'Data curation':                    '#00BBCC',  // cyan-teal

  // ── Group 3: Analysis & writing (pink → red-pink / magenta) ────────────
  'Formal analysis':                  '#CC0066',  // deep magenta, near Primary 3
  'Software':                         '#E80044',  // red-magenta
  'Writing \u2013 original draft':    '#AA0044',  // dark rose-red
  'Writing \u2013 review & editing':  '#EE1166',  // hot pink-red
  'Visualization':                    '#FF3388',  // bright pink
};

// Also used in the popover badge role abbreviation — no shortening needed in the legend.
// (The popover still abbreviates for space; only the legend shows full names.)
const _ROLE_ABBREV = (r) => r
  .replace('Writing \u2013 ', 'W: ')
  .replace('Formal analysis', 'Formal anal.');

const _PALETTE = [
  '#4f46e5', '#0d9488', '#7c3aed', '#d97706',
  '#e11d48', '#059669', '#1e40af', '#4338ca',
  '#be185d', '#0891b2', '#65a30d', '#9333ea',
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function _hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

function _nodeColor(name) { return _PALETTE[_hash(name) % _PALETTE.length]; }

function _initials(name) {
  const p = name.trim().split(/\s+/);
  return p.length === 1 ? p[0][0].toUpperCase() : (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function _lastName(name) {
  const p = name.trim().split(/\s+/);
  return p[p.length - 1];
}

function _normalizeRole(r) {
  return r.toLowerCase().replace(/\s+/g, ' ').replace(/\u2014/g, '\u2013').trim();
}

function _hasRole(author, roleName) {
  if (!author.credit_levels) return false;
  const norm = _normalizeRole(roleName);
  return author.credit_levels.some(cl => _normalizeRole(cl.role) === norm);
}

function _getAffKey(aff) {
  if (aff == null) return '__unknown__';
  if (typeof aff === 'string') return aff;
  return aff.id || aff.name || JSON.stringify(aff);
}

function _getAffLabel(aff) {
  if (aff == null) return 'Unknown affiliation';
  if (typeof aff === 'string') return aff;
  let label = aff.name || aff.id || 'Unknown';
  if (aff.department) label = `${aff.department}, ${label}`;
  return label;
}

function _isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme:dark)').matches);
}

// ── SVG element factory ───────────────────────────────────────────────────────

function _svg(tag, attrs) {
  const e = document.createElementNS(_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ── CSS injection ─────────────────────────────────────────────────────────────

let _cssInjected = false;

function _injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.id = 'ae-explore-css';
  s.textContent = `
    @keyframes ae-xpop-in {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .ae-explore-wrap {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      min-height: ${_CH}px;
      gap: 0;
    }
    .ae-explore-svg-wrap {
      position: relative;
      overflow: hidden;
    }
    .ae-explore-zoom-btns {
      position: absolute;
      bottom: 10px;
      right: 10px;
      display: flex;
      flex-direction: column;
      gap: 3px;
      z-index: 10;
    }
    .ae-explore-zoom-btn {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid #d1d5db;
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(6px);
      font-size: 16px;
      line-height: 1;
      color: #374151;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s;
      user-select: none;
    }
    .ae-explore-zoom-btn:hover {
      background: rgba(230,230,255,0.95);
    }
    html[data-theme="dark"] .ae-explore-zoom-btn {
      background: rgba(31,41,55,0.92);
      border-color: #4b5563;
      color: #d1d5db;
    }
    html[data-theme="dark"] .ae-explore-zoom-btn:hover {
      background: rgba(55,65,81,0.95);
    }
    .ae-explore-zoom-hint {
      position: absolute;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      color: #9ca3af;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }
    .ae-explore-legend {
      width: 200px;
      flex-shrink: 0;
      padding: 10px 6px;
      display: flex;
      flex-direction: column;
      gap: 1px;
      overflow-y: auto;
    }
    /* Affiliations panel: let it size to content on wide screens */
    .ae-explore-legend-right {
      width: auto;
      min-width: 180px;
      max-width: 280px;
    }
    @media (max-width: 900px) {
      .ae-explore-legend { width: 140px; }
      .ae-explore-legend-right { min-width: 120px; max-width: 200px; }
    }
    .ae-explore-legend-title {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: #9ca3af;
      padding: 0 4px 6px;
      white-space: nowrap;
    }
    .ae-explore-legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
      transition: background 0.14s;
    }
    .ae-explore-legend-item:hover,
    .ae-explore-legend-item.ae-xleg-active {
      background: rgba(0,0,0,0.06);
    }
    html[data-theme="dark"] .ae-explore-legend-item:hover,
    html[data-theme="dark"] .ae-explore-legend-item.ae-xleg-active {
      background: rgba(255,255,255,0.08);
    }
    .ae-explore-legend-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .ae-explore-legend-label {
      font-size: 11px;
      color: #374151;
      line-height: 1.3;
      overflow-wrap: break-word;
      min-width: 0;
    }
    html[data-theme="dark"] .ae-explore-legend-label { color: #d1d5db; }
    .ae-explore-legend-count {
      font-size: 10px;
      color: #9ca3af;
      margin-left: auto;
      flex-shrink: 0;
      padding-left: 4px;
    }
    .ae-explore-legend-sep {
      height: 1px;
      background: #e5e7eb;
      margin: 5px 4px;
    }
    html[data-theme="dark"] .ae-explore-legend-sep { background: #374151; }
    .ae-explore-svg {
      display: block;
      width: 100%;
      height: ${_CH}px;
      cursor: grab;
    }
    .ae-explore-svg.ae-dragging {
      cursor: grabbing;
    }
    .ae-explore-node {
      cursor: pointer;
    }
    .ae-explore-node-initials {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      font-weight: 700;
      fill: #fff;
      pointer-events: none;
      user-select: none;
    }
    .ae-explore-node-label {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 11px;
      font-weight: 500;
      fill: #374151;
      pointer-events: none;
      user-select: none;
    }
    html[data-theme="dark"] .ae-explore-node-label { fill: #d1d5db; }
    .ae-explore-strand {
      stroke-linecap: round;
    }
    .ae-explore-stats {
      font-size: 11px;
      color: #9ca3af;
      text-align: center;
      padding: 5px 0 2px;
    }
    html[data-theme="dark"] .ae-explore-stats { color: #6b7280; }
  `;
  document.head.appendChild(s);
}

// ── Tooltip popover ───────────────────────────────────────────────────────────

let _xpopEl  = null;
let _xpopTid = null;

function _showXpop(anchorEl, author) {
  _hideXpop();
  const dark = _isDark();
  const bg     = dark ? 'rgba(31,41,55,0.97)'  : 'rgba(255,255,255,0.97)';
  const border = dark ? '#4b5563'               : '#e5e7eb';
  const nameC  = dark ? '#f3f4f6'               : '#111827';
  const subC   = dark ? '#9ca3af'               : '#6b7280';

  const pop = document.createElement('div');
  pop.style.cssText = [
    'position:fixed', 'z-index:10002', 'width:230px',
    `background:${bg}`, 'backdrop-filter:blur(12px)',
    `border:1px solid ${border}`, 'border-radius:10px',
    'box-shadow:0 8px 24px rgba(0,0,0,0.13),0 2px 6px rgba(0,0,0,0.07)',
    'padding:11px 13px',
    "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    'font-size:12px', `color:${nameC}`, 'pointer-events:none',
    'animation:ae-xpop-in 0.13s ease-out',
  ].join(';');

  // Header row: avatar + name + career stage
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:9px;margin-bottom:7px;';
  const avEl = document.createElement('div');
  const avColor = _nodeColor(author.name);
  avEl.style.cssText = [
    `background:${avColor}`, 'border-radius:50%',
    'width:30px', 'height:30px', 'flex-shrink:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    "font-family:'Inter',-apple-system,sans-serif",
    'font-size:11px', 'font-weight:700', 'color:#fff',
  ].join(';');

  // Photo support: if author.avatar_url is provided, show it clipped to a circle.
  // Otherwise fall back to colored initials.
  if (author.avatar_url) {
    const img = document.createElement('img');
    img.src = author.avatar_url;
    img.alt = author.name;
    img.style.cssText = 'width:30px;height:30px;border-radius:50%;object-fit:cover;flex-shrink:0;';
    header.appendChild(img);
  } else {
    avEl.textContent = _initials(author.name);
    header.appendChild(avEl);
  }

  const nameBlock = document.createElement('div');
  nameBlock.style.cssText = 'min-width:0;';
  const nameEl = document.createElement('div');
  nameEl.style.cssText = `font-size:13px;font-weight:700;color:${nameC};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
  nameEl.textContent = author.name;
  nameBlock.appendChild(nameEl);
  if (author.career_stage) {
    const stageEl = document.createElement('div');
    stageEl.style.cssText = `font-size:11px;color:${subC};`;
    stageEl.textContent = author.career_stage;
    nameBlock.appendChild(stageEl);
  }
  header.appendChild(nameBlock);
  pop.appendChild(header);

  // Affiliation
  if (author.affiliations?.length) {
    const affEl = document.createElement('div');
    affEl.style.cssText = `font-size:11px;color:${subC};margin-bottom:7px;line-height:1.4;`;
    affEl.textContent = author.affiliations
      .map(a => (typeof a === 'string' ? a : (a.name || '')))
      .filter(Boolean)
      .join(' · ');
    pop.appendChild(affEl);
  }

  // CRediT role badges
  const credits = author.credit_levels || [];
  if (credits.length) {
    const rolesEl = document.createElement('div');
    rolesEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px;';
    for (const cr of credits) {
      const badge = document.createElement('span');
      const lvl = (cr.level || '').toLowerCase();
      const [bgC, textC] =
        lvl === 'lead'       ? ['#4338ca', '#fff']    :
        lvl === 'equal'      ? ['#a5b4fc', '#312e81'] :
                               ['#e5e7eb', '#4b5563'];
      badge.style.cssText = `padding:2px 6px;border-radius:8px;font-size:10px;font-weight:500;background:${bgC};color:${textC};white-space:nowrap;`;
      badge.textContent = _ROLE_ABBREV(cr.role);
      rolesEl.appendChild(badge);
    }
    pop.appendChild(rolesEl);
  }

  // Stats footer
  const statsEl = document.createElement('div');
  statsEl.style.cssText = `font-size:10px;color:${subC};border-top:1px solid ${border};padding-top:5px;display:flex;gap:10px;`;
  if (credits.length) statsEl.appendChild(Object.assign(document.createElement('span'), { textContent: `${credits.length} role${credits.length === 1 ? '' : 's'}` }));
  if ((author.section_contributions || []).length) statsEl.appendChild(Object.assign(document.createElement('span'), { textContent: `${author.section_contributions.length} sections` }));
  if (statsEl.childNodes.length) pop.appendChild(statsEl);

  document.body.appendChild(pop);
  _xpopEl = pop;

  // Position: prefer below anchor, flip up if not enough space
  const rect = anchorEl.getBoundingClientRect();
  const pw = 230;
  const ph = pop.offsetHeight || 110;
  let top  = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - pw / 2;
  if (left < 8) left = 8;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
}

function _hideXpop() {
  clearTimeout(_xpopTid);
  if (_xpopEl) { _xpopEl.remove(); _xpopEl = null; }
}

// ── Build simulation data ─────────────────────────────────────────────────────

function _buildSimData(authors) {
  // Nodes
  const nodes = authors.map((author, i) => {
    const primaryAff = author.affiliations?.[0] ?? null;
    return { author, i, x: 0, y: 0, vx: 0, vy: 0, clusterKey: _getAffKey(primaryAff) };
  });

  // Edges: one per author-pair that shares ≥1 CRediT role
  const edges = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const shared = _ROLES.filter(
        r => _hasRole(nodes[a].author, r) && _hasRole(nodes[b].author, r)
      );
      if (shared.length) edges.push({ source: a, target: b, roles: shared });
    }
  }

  // Cluster map: one entry per unique primary affiliation
  const clusterMap = {};
  for (const node of nodes) {
    if (!clusterMap[node.clusterKey]) {
      const aff = node.author.affiliations?.[0] ?? null;
      clusterMap[node.clusterKey] = {
        key: node.clusterKey,
        label: _getAffLabel(aff),
        nodeIndices: [],
        cx: 0, cy: 0,
      };
    }
    clusterMap[node.clusterKey].nodeIndices.push(node.i);
  }

  return { nodes, edges, clusterMap };
}

// ── Force simulation ──────────────────────────────────────────────────────────

function _runSimulation(nodes, edges, clusterMap, width, height) {
  // Run in world-space coordinates (_WW × _WH), not viewport coordinates
  const cx = width / 2, cy = height / 2;

  // Assign cluster target positions evenly around the canvas center
  const keys = Object.keys(clusterMap);
  const spread = Math.min(width, height) * 0.30;
  if (keys.length === 1) {
    clusterMap[keys[0]].cx = cx;
    clusterMap[keys[0]].cy = cy;
  } else {
    keys.forEach((k, i) => {
      const angle = (2 * Math.PI * i) / keys.length - Math.PI / 2;
      clusterMap[k].cx = cx + spread * Math.cos(angle);
      clusterMap[k].cy = cy + spread * Math.sin(angle);
    });
  }

  // Seed node positions near their cluster center
  for (const n of nodes) {
    const cl = clusterMap[n.clusterKey];
    const jitter = _NR * 2.8;
    n.x = cl.cx + (Math.random() - 0.5) * jitter * 2;
    n.y = cl.cy + (Math.random() - 0.5) * jitter * 2;
    n.vx = 0; n.vy = 0;
  }

  const N = nodes.length;
  const fx = new Float64Array(N);
  const fy = new Float64Array(N);

  for (let step = 0; step < _SIM; step++) {
    fx.fill(0); fy.fill(0);

    // Charge repulsion (O(n²) — fine for small author lists)
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const dx = nodes[b].x - nodes[a].x;
        const dy = nodes[b].y - nodes[a].y;
        const d2 = dx * dx + dy * dy || 0.01;
        const d  = Math.sqrt(d2);
        const f  = _REP / d2;
        const nx = dx / d, ny = dy / d;
        fx[a] -= nx * f; fy[a] -= ny * f;
        fx[b] += nx * f; fy[b] += ny * f;
      }
    }

    // Spring forces along edges
    for (const e of edges) {
      const a = nodes[e.source], b = nodes[e.target];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const restLen = _SR + (e.roles.length - 1) * 12;
      const stretch = d - restLen;
      const f  = _SK * stretch;
      const nx = dx / d, ny = dy / d;
      fx[e.source] += nx * f; fy[e.source] += ny * f;
      fx[e.target] -= nx * f; fy[e.target] -= ny * f;
    }

    // Cluster gravity (toward institution centroid)
    for (const n of nodes) {
      const cl = clusterMap[n.clusterKey];
      fx[n.i] += (cl.cx - n.x) * _CK;
      fy[n.i] += (cl.cy - n.y) * _CK;
    }

    // Global center gravity
    for (const n of nodes) {
      fx[n.i] += (cx - n.x) * _GK;
      fy[n.i] += (cy - n.y) * _GK;
    }

    // Integrate
    for (const n of nodes) {
      n.vx = (n.vx + fx[n.i]) * _DAMP;
      n.vy = (n.vy + fy[n.i]) * _DAMP;
      n.x += n.vx;
      n.y += n.vy;
    }

    // Collision resolution (hard-push overlapping nodes apart)
    const minD = _NR * 2.4;
    for (let a = 0; a < N; a++) {
      for (let b = a + 1; b < N; b++) {
        const dx = nodes[b].x - nodes[a].x;
        const dy = nodes[b].y - nodes[a].y;
        const d  = Math.sqrt(dx * dx + dy * dy) || 0.01;
        if (d < minD) {
          const push = (minD - d) / 2;
          const nx = dx / d, ny = dy / d;
          nodes[a].x -= nx * push; nodes[a].y -= ny * push;
          nodes[b].x += nx * push; nodes[b].y += ny * push;
        }
      }
    }

    // Clamp to canvas bounds
    for (const n of nodes) {
      n.x = Math.max(_PAD, Math.min(width  - _PAD, n.x));
      n.y = Math.max(_PAD, Math.min(height - _PAD, n.y));
    }
  }
}

// ── SVG rendering ─────────────────────────────────────────────────────────────

function _renderGraph(svgEl, nodes, edges, width, height) {
  svgEl.innerHTML = '';
  // viewBox matches the world dimensions so the simulation coordinates map directly
  svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // Defs: clip paths for circular avatar images (one per node, for future photo support)
  const defs = _svg('defs');
  for (const n of nodes) {
    const cp = _svg('clipPath', { id: `ae-xclip-${n.i}` });
    cp.appendChild(_svg('circle', { cx: '0', cy: '0', r: String(_NR) }));
    defs.appendChild(cp);
  }
  svgEl.appendChild(defs);

  // ── Edges layer ──
  const edgesG   = _svg('g', { class: 'ae-explore-edges' });
  const edgeData = [];

  for (const edge of edges) {
    const g = _svg('g', {
      class: 'ae-explore-edge',
      'data-source': String(edge.source),
      'data-target': String(edge.target),
    });
    const strands = [];
    for (const role of edge.roles) {
      const line = _svg('line', {
        class: 'ae-explore-strand',
        stroke: _ROLE_COLOR[role] || '#888',
        'stroke-width': '2.2',
        'stroke-opacity': '0.12',
      });
      line.dataset.role = role;
      g.appendChild(line);
      strands.push(line);
    }
    edgesG.appendChild(g);
    edgeData.push({ edge, g, strands });
  }
  svgEl.appendChild(edgesG);

  // ── Nodes layer ──
  const nodesG   = _svg('g', { class: 'ae-explore-nodes' });
  const nodeData = [];

  for (const node of nodes) {
    const { author, i } = node;
    const color = _nodeColor(author.name);

    const g = _svg('g', {
      class: 'ae-explore-node',
      'data-index': String(i),
      transform: `translate(${Math.round(node.x)},${Math.round(node.y)})`,
    });

    // Subtle glow circle (shown on hover via opacity attribute)
    const glow = _svg('circle', {
      r: String(_NR + 6),
      fill: color,
      'fill-opacity': '0',
    });
    g.appendChild(glow);

    // Main avatar circle
    const circle = _svg('circle', {
      r: String(_NR),
      fill: color,
      stroke: '#fff',
      'stroke-width': '2',
    });
    g.appendChild(circle);

    // Avatar content: photo (if author.avatar_url is provided) or colored initials.
    // Photo support is ready — simply set author.avatar_url to a URL string.
    if (author.avatar_url) {
      const img = _svg('image', {
        href: author.avatar_url,
        x: String(-_NR), y: String(-_NR),
        width: String(_NR * 2), height: String(_NR * 2),
        'clip-path': `url(#ae-xclip-${i})`,
        preserveAspectRatio: 'xMidYMid slice',
      });
      g.appendChild(img);
    } else {
      const txt = _svg('text', {
        class: 'ae-explore-node-initials',
        x: '0', y: '0',
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      txt.textContent = _initials(author.name);
      g.appendChild(txt);
    }

    // Last name label below circle
    const label = _svg('text', {
      class: 'ae-explore-node-label',
      x: '0', y: String(_NR + 13),
      'text-anchor': 'middle',
      'dominant-baseline': 'hanging',
    });
    label.textContent = _lastName(author.name);
    g.appendChild(label);

    nodesG.appendChild(g);
    nodeData.push({ node, g, circle, glow });
  }
  svgEl.appendChild(nodesG);

  // Position all edges at their initial (post-simulation) coordinates
  _updateEdgePositions(edgeData, nodes);

  return { nodeData, edgeData };
}

function _updateEdgePositions(edgeData, nodes) {
  for (const { edge, strands } of edgeData) {
    const a = nodes[edge.source], b = nodes[edge.target];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / len, ny = dy / len;   // unit vector along edge
    const px = -ny,       py =  nx;       // perpendicular unit vector
    const n = strands.length;

    strands.forEach((line, si) => {
      const offset = (si - (n - 1) / 2) * _CGAP;
      // Shorten ends so they start/end at the node circle perimeter
      line.setAttribute('x1', String(Math.round(a.x + nx * _NR + px * offset)));
      line.setAttribute('y1', String(Math.round(a.y + ny * _NR + py * offset)));
      line.setAttribute('x2', String(Math.round(b.x - nx * _NR + px * offset)));
      line.setAttribute('y2', String(Math.round(b.y - ny * _NR + py * offset)));
    });
  }
}

// ── Hover state machine ───────────────────────────────────────────────────────

function _applyHoverState(state, nodeData, edgeData, nodes) {
  const { type } = state;

  if (!type) {
    // Default: all nodes fully visible, all strands faded
    for (const { g, circle, glow } of nodeData) {
      g.setAttribute('opacity', '1');
      circle.setAttribute('r', String(_NR));
      glow.setAttribute('fill-opacity', '0');
    }
    for (const { strands } of edgeData) {
      for (const s of strands) s.setAttribute('stroke-opacity', '0.12');
    }
    return;
  }

  if (type === 'node') {
    const { index } = state;
    // Build set of directly-connected neighbours
    const neighbours = new Set();
    for (const { edge } of edgeData) {
      if (edge.source === index) neighbours.add(edge.target);
      else if (edge.target === index) neighbours.add(edge.source);
    }

    for (const { node, g, circle, glow } of nodeData) {
      if (node.i === index) {
        g.setAttribute('opacity', '1');
        circle.setAttribute('r', String(_NR + 3));
        glow.setAttribute('fill-opacity', '0.14');
      } else if (neighbours.has(node.i)) {
        g.setAttribute('opacity', '0.92');
        circle.setAttribute('r', String(_NR));
        glow.setAttribute('fill-opacity', '0');
      } else {
        g.setAttribute('opacity', neighbours.size === 0 ? '0.9' : '0.20');
        circle.setAttribute('r', String(_NR));
        glow.setAttribute('fill-opacity', '0');
      }
    }
    for (const { edge, strands } of edgeData) {
      const mine = edge.source === index || edge.target === index;
      for (const s of strands) s.setAttribute('stroke-opacity', mine ? '0.82' : '0.04');
    }
    return;
  }

  if (type === 'role') {
    const { role } = state;
    for (const { node, g, circle, glow } of nodeData) {
      const has = _hasRole(node.author, role);
      g.setAttribute('opacity', has ? '1' : '0.18');
      circle.setAttribute('r', has ? String(_NR + 2) : String(_NR));
      glow.setAttribute('fill-opacity', has ? '0.12' : '0');
    }
    for (const { strands } of edgeData) {
      for (const s of strands) {
        s.setAttribute('stroke-opacity', s.dataset.role === role ? '0.82' : '0.02');
      }
    }
    return;
  }

  if (type === 'affiliation') {
    const { affKey } = state;
    for (const { node, g, circle, glow } of nodeData) {
      const match = node.clusterKey === affKey;
      g.setAttribute('opacity', match ? '1' : '0.18');
      circle.setAttribute('r', match ? String(_NR + 2) : String(_NR));
      glow.setAttribute('fill-opacity', match ? '0.12' : '0');
    }
    for (const { edge, strands } of edgeData) {
      const aMatch = nodes[edge.source].clusterKey === affKey;
      const bMatch = nodes[edge.target].clusterKey === affKey;
      const opacity = (aMatch && bMatch) ? '0.55' : (aMatch || bMatch) ? '0.12' : '0.02';
      for (const s of strands) s.setAttribute('stroke-opacity', opacity);
    }
  }
}

// ── Legend builders ───────────────────────────────────────────────────────────

function _buildLeftLegend(el, nodes, onHover, onLeave) {
  el.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'ae-explore-legend-title';
  title.textContent = 'CRediT Roles';
  el.appendChild(title);

  // Only show roles that at least one author holds
  const activeRoles = _ROLES.filter(role => nodes.some(n => _hasRole(n.author, role)));

  for (const role of activeRoles) {
    const item = document.createElement('div');
    item.className = 'ae-explore-legend-item';
    item.title = role;

    const dot = document.createElement('span');
    dot.className = 'ae-explore-legend-dot';
    dot.style.backgroundColor = _ROLE_COLOR[role] || '#888';
    item.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'ae-explore-legend-label';
    label.textContent = role;
    item.appendChild(label);

    item.addEventListener('mouseenter', () => {
      item.classList.add('ae-xleg-active');
      onHover(role);
    });
    item.addEventListener('mouseleave', () => {
      item.classList.remove('ae-xleg-active');
      onLeave();
    });
    el.appendChild(item);
  }
}

function _buildRightLegend(el, clusterMap, onHover, onLeave) {
  el.innerHTML = '';

  const entries = Object.values(clusterMap).filter(c => c.nodeIndices.length > 0);

  // Hide the right panel when there's only one distinct affiliation
  if (entries.length <= 1) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';

  const title = document.createElement('div');
  title.className = 'ae-explore-legend-title';
  title.textContent = 'Affiliations';
  el.appendChild(title);

  for (const cluster of entries) {
    const item = document.createElement('div');
    item.className = 'ae-explore-legend-item';

    const label = document.createElement('span');
    label.className = 'ae-explore-legend-label';
    label.textContent = cluster.label;
    item.appendChild(label);

    const count = document.createElement('span');
    count.className = 'ae-explore-legend-count';
    count.textContent = String(cluster.nodeIndices.length);
    item.appendChild(count);

    item.addEventListener('mouseenter', () => {
      item.classList.add('ae-xleg-active');
      onHover(cluster.key);
    });
    item.addEventListener('mouseleave', () => {
      item.classList.remove('ae-xleg-active');
      onLeave();
    });
    el.appendChild(item);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Mount the Explore network view inside `container`.
 *
 * @param {HTMLElement} container - Host element (the tab content div from preview.js).
 * @param {Array}       authors   - Author objects in widget format (from view.js).
 * @param {Object|null} zoomState - Mutable object { scale, tx, ty } shared with the caller.
 *   The caller should pass the same object reference each time so zoom is preserved across
 *   tab switches. Pass null (or omit) on first render; a fresh fit-to-view will be used.
 * @returns {Function}            - Cleanup function; call when unmounting.
 */
export function createExploreView(container, authors, zoomState) {
  _injectCSS();
  if (!authors || authors.length === 0) return () => {};

  // ── Layout skeleton ──
  const wrap = document.createElement('div');
  wrap.className = 'ae-explore-wrap';

  const leftLegend = document.createElement('div');
  leftLegend.className = 'ae-explore-legend ae-explore-legend-left';
  wrap.appendChild(leftLegend);

  const svgWrap = document.createElement('div');
  svgWrap.className = 'ae-explore-svg-wrap';
  svgWrap.style.cssText = 'flex:1;min-width:0;overflow:hidden;position:relative;';
  const svgEl = document.createElementNS(_NS, 'svg');
  svgEl.setAttribute('class', 'ae-explore-svg');
  svgWrap.appendChild(svgEl);
  wrap.appendChild(svgWrap);

  const rightLegend = document.createElement('div');
  rightLegend.className = 'ae-explore-legend ae-explore-legend-right';
  wrap.appendChild(rightLegend);

  const statsBar = document.createElement('div');
  statsBar.className = 'ae-explore-stats';

  container.appendChild(wrap);
  container.appendChild(statsBar);

  // ── Sim data ──
  const { nodes, edges, clusterMap } = _buildSimData(authors);

  // ── Hover state ──
  let hoverState = { type: null };
  let nodeData   = [];
  let edgeData   = [];

  function applyHover() {
    _applyHoverState(hoverState, nodeData, edgeData, nodes);
  }

  // ── Legends (built before simulation so they appear immediately) ──
  _buildLeftLegend(leftLegend, nodes,
    role   => { hoverState = { type: 'role', role };           applyHover(); },
    ()     => { hoverState = { type: null };                   applyHover(); },
  );

  _buildRightLegend(rightLegend, clusterMap,
    affKey => { hoverState = { type: 'affiliation', affKey };  applyHover(); },
    ()     => { hoverState = { type: null };                   applyHover(); },
  );

  // ── Deferred initialisation (needs container dimensions from the DOM layout) ──
  let rafId = null;
  const _cleanupFns = [];

  function initialize() {
    // Simulate in world space (_WW × _WH); the SVG viewBox matches world space.
    // The viewport is _CH px tall — we use a CSS transform on the <g> for zoom/pan.
    const w = _WW;
    const h = _WH;

    _runSimulation(nodes, edges, clusterMap, w, h);

    const result = _renderGraph(svgEl, nodes, edges, w, h);
    nodeData = result.nodeData;
    edgeData = result.edgeData;

    // ── Zoom / pan state ──
    // We fit the world into the visible viewport on load, then let the user zoom from there.
    const vw = svgWrap.clientWidth  || 600;
    const vh = _CH;
    const fitScale = Math.min(vw / w, vh / h) * 0.92; // initial fit-to-view with a little margin
    // Zoom limits: can't zoom out past ~fit view (+ 10% breathing room), can zoom in to ~2.5× fit
    const minScale = fitScale * 0.90;
    const maxScale = fitScale * 2.5;
    // Restore saved zoom/pan if available; otherwise start at fit-to-view
    let scale = (zoomState && zoomState.scale != null) ? zoomState.scale : fitScale;
    let tx    = (zoomState && zoomState.tx    != null) ? zoomState.tx    : (vw - w * scale) / 2;
    let ty    = (zoomState && zoomState.ty    != null) ? zoomState.ty    : (vh - h * scale) / 2;

    // Helper: write current transform back to the shared zoomState object
    function saveZoom() {
      if (zoomState) { zoomState.scale = scale; zoomState.tx = tx; zoomState.ty = ty; }
    }

    // The SVG element is sized to the visible viewport; a <g> inside carries the world transform.
    svgEl.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    svgEl.setAttribute('width',  String(vw));
    svgEl.setAttribute('height', String(vh));

    // Wrap all rendered children in a transform group
    const worldG = svgEl.querySelector('g.ae-explore-edges')?.parentNode === svgEl
      ? (() => {
          const g = document.createElementNS(_NS, 'g');
          g.setAttribute('class', 'ae-explore-world');
          // Move existing children into the world group
          while (svgEl.firstChild) g.appendChild(svgEl.firstChild);
          svgEl.appendChild(g);
          return g;
        })()
      : svgEl.querySelector('.ae-explore-world');

    function applyTransform() {
      worldG.setAttribute('transform', `translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)})`);
      saveZoom();
    }
    applyTransform();

    function clampTranslation() {
      // Allow the world to be dragged but keep at least 20% visible on each axis
      const margin = 60;
      const maxTx = vw - margin;
      const minTx = -(w * scale - margin);
      const maxTy = vh - margin;
      const minTy = -(h * scale - margin);
      tx = Math.max(minTx, Math.min(maxTx, tx));
      ty = Math.max(minTy, Math.min(maxTy, ty));
    }

    // Wheel to zoom — multiplicative so speed feels consistent across mouse & trackpad
    svgEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect   = svgEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      // Clamp raw deltaY so one hard mouse-wheel tick doesn't overshoot
      const dy       = Math.max(-40, Math.min(40, e.deltaY));
      const factor   = 1 - dy * _ZOOM_WHEEL_SENSITIVITY;
      const newScale = Math.max(minScale, Math.min(maxScale, scale * factor));
      // Zoom toward the mouse cursor
      tx = mouseX - (mouseX - tx) * (newScale / scale);
      ty = mouseY - (mouseY - ty) * (newScale / scale);
      scale = newScale;
      clampTranslation();
      applyTransform();
    }, { passive: false });

    // Drag to pan
    let dragging = false;
    let dragStartX = 0, dragStartY = 0;
    let dragStartTx = 0, dragStartTy = 0;

    svgEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging   = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragStartTx = tx;
      dragStartTy = ty;
      svgEl.classList.add('ae-dragging');
      e.preventDefault();
    });
    const onMouseMove = (e) => {
      if (!dragging) return;
      tx = dragStartTx + (e.clientX - dragStartX);
      ty = dragStartTy + (e.clientY - dragStartY);
      clampTranslation();
      applyTransform();
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      svgEl.classList.remove('ae-dragging');
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    _cleanupFns.push(() => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    });

    // Zoom buttons
    const zoomBtns = document.createElement('div');
    zoomBtns.className = 'ae-explore-zoom-btns';
    const btnIn  = document.createElement('button');
    btnIn.className  = 'ae-explore-zoom-btn';
    btnIn.title      = 'Zoom in';
    btnIn.textContent = '+';
    btnIn.addEventListener('click', () => {
      const newScale = Math.min(maxScale, scale * _ZOOM_BTN_FACTOR);
      // Zoom toward viewport center
      tx = vw / 2 - (vw / 2 - tx) * (newScale / scale);
      ty = vh / 2 - (vh / 2 - ty) * (newScale / scale);
      scale = newScale;
      clampTranslation();
      applyTransform();
    });
    const btnOut = document.createElement('button');
    btnOut.className  = 'ae-explore-zoom-btn';
    btnOut.title      = 'Zoom out';
    btnOut.textContent = '−';
    btnOut.addEventListener('click', () => {
      const newScale = Math.max(minScale, scale / _ZOOM_BTN_FACTOR);
      tx = vw / 2 - (vw / 2 - tx) * (newScale / scale);
      ty = vh / 2 - (vh / 2 - ty) * (newScale / scale);
      scale = newScale;
      clampTranslation();
      applyTransform();
    });
    const btnReset = document.createElement('button');
    btnReset.className  = 'ae-explore-zoom-btn';
    btnReset.title      = 'Reset zoom';
    btnReset.textContent = '⊙';
    btnReset.style.fontSize = '13px';
    btnReset.addEventListener('click', () => {
      scale = fitScale;
      tx    = (vw - w * scale) / 2;
      ty    = (vh - h * scale) / 2;
      applyTransform();
    });
    zoomBtns.appendChild(btnIn);
    zoomBtns.appendChild(btnOut);
    zoomBtns.appendChild(btnReset);
    svgWrap.appendChild(zoomBtns);

    // Hint label
    const hint = document.createElement('div');
    hint.className = 'ae-explore-zoom-hint';
    hint.textContent = 'scroll to zoom · drag to pan';
    svgWrap.appendChild(hint);
    // Fade out hint after 4 s
    setTimeout(() => { hint.style.transition = 'opacity 0.8s'; hint.style.opacity = '0'; }, 4000);
    setTimeout(() => { hint.remove(); }, 5000);

    // Node hover interactions
    for (const { node, g } of nodeData) {
      let enterTid = null;
      g.addEventListener('mouseenter', () => {
        if (dragging) return;
        clearTimeout(enterTid);
        enterTid = setTimeout(() => {
          hoverState = { type: 'node', index: node.i };
          applyHover();
          _showXpop(g, node.author);
        }, 180);
      });
      g.addEventListener('mouseleave', () => {
        clearTimeout(enterTid);
        _xpopTid = setTimeout(() => {
          hoverState = { type: null };
          applyHover();
          _hideXpop();
        }, 120);
      });
    }

    // Stats bar
    const totalStrands = edges.reduce((s, e) => s + e.roles.length, 0);
    const numClusters  = Object.keys(clusterMap).length;
    statsBar.textContent =
      `${authors.length} contributor${authors.length === 1 ? '' : 's'} \u00b7 ` +
      `${edges.length} shared-role connection${edges.length === 1 ? '' : 's'} \u00b7 ` +
      `${totalStrands} role strand${totalStrands === 1 ? '' : 's'} \u00b7 ` +
      `${numClusters} institution${numClusters === 1 ? '' : 's'}`;

    applyHover();
  }

  rafId = requestAnimationFrame(() => {
    if (wrap.isConnected) initialize();
  });

  // ── Dark-mode observer: CSS handles most of it; re-render popover colours lazily ──
  const darkObs = new MutationObserver(() => {
    // SVG fill/stroke colours come from attributes set at render time;
    // no re-render needed. CSS variables handle label colour.
  });
  darkObs.observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme', 'class'],
  });

  return function cleanup() {
    if (rafId) cancelAnimationFrame(rafId);
    darkObs.disconnect();
    _hideXpop();
    for (const fn of _cleanupFns) fn();
    wrap.remove();
    statsBar.remove();
  };
}
