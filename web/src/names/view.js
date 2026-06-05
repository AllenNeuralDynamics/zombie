/**
 * names/view.js — Hidden page: experimenter name normalization graph.
 *
 * Queries asset_basics for (experimenters, experimenters_normalized),
 * builds a bipartite mapping of raw → normalized, anonymizes all names
 * via a per-person cipher, then renders an SVG directed graph.
 *
 * The cipher works as follows:
 *   - Each unique normalized name gets a fake name from a nature-word pool.
 *   - The last-name initial is shifted +7 in the alphabet  (B→I, M→T, etc.).
 *   - For each original (un-normalized) variant, the first token is replaced
 *     with the fake first name, and any subsequent token that starts with the
 *     real last initial has that first character replaced with the fake initial.
 */

import { arrowTableToRows } from '../lib/assets-table.js';
import { escHtml } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Anonymization — fixed letter-substitution cipher
// ---------------------------------------------------------------------------

/**
 * Fixed alphabet substitution table (QWERTY-based permutation).
 * Maps every ASCII letter to a different letter, preserving case.
 * All non-alphabetic characters (spaces, commas, dots, hyphens, etc.) pass through unchanged.
 *
 * Plain:  A B C D E F G H I J K L M N O P Q R S T U V W X Y Z
 * Cipher: Q W E R T Y U I O P A S D F G H J K L Z X C V B N M
 */
const ALPHA_MAP = (() => {
  const plain  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const cipher = 'QWERTYUIOPASDFGHJKLZXCVBNM';
  const map = Object.create(null);
  for (let i = 0; i < 26; i++) {
    map[plain[i]] = cipher[i];
    map[plain[i].toLowerCase()] = cipher[i].toLowerCase();
  }
  return map;
})();

/**
 * Anonymize a name string by substituting each alphabetic character using
 * ALPHA_MAP. Case, length, spacing, and punctuation are all preserved.
 *
 * @param {string} str
 * @returns {string}
 */
function anonymizeName(str) {
  return str.split('').map((ch) => ALPHA_MAP[ch] ?? ch).join('');
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated name string into trimmed, non-empty tokens.
 * @param {string|null} val
 * @returns {string[]}
 */
function parseNames(val) {
  if (!val) return [];
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the raw-to-normalized mapping from DuckDB rows.
 *
 * Both `experimenters` and `experimenters_normalized` are comma-separated lists
 * whose entries are positionally aligned (index i in experimenters corresponds
 * to index i in experimenters_normalized).
 *
 * @param {object[]} rows - Rows with `experimenters` and `experimenters_normalized`.
 * @returns {Map<string, Set<string>>} normalized name → set of raw name variants
 */
function buildMapping(rows) {
  const normToRaws = new Map();
  const rawCounts = new Map();   // raw name → asset count
  const normCounts = new Map();  // normalized name → asset count
  for (const row of rows) {
    const originals = parseNames(row.experimenters);
    const normalized = parseNames(row.experimenters_normalized);
    const len = Math.min(originals.length, normalized.length);
    for (let i = 0; i < len; i++) {
      const orig = originals[i];
      const norm = normalized[i];
      if (!orig || !norm) continue;
      if (!normToRaws.has(norm)) normToRaws.set(norm, new Set());
      normToRaws.get(norm).add(orig);
      rawCounts.set(orig, (rawCounts.get(orig) ?? 0) + 1);
      normCounts.set(norm, (normCounts.get(norm) ?? 0) + 1);
    }
  }
  return { normToRaws, rawCounts, normCounts };
}

// ---------------------------------------------------------------------------
// SVG graph renderer
// ---------------------------------------------------------------------------

// Tableau10 palette — legible on both light and dark backgrounds
const PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

const ROW_H = 26;          // pixels per name row
const GROUP_GAP = 14;      // extra space between clusters
const ORIG_X = 30;         // x where original-name labels start (left-aligned)
const NODE_ORIG_X = 290;   // x of original-name circle
const NODE_NORM_X = 420;   // x of normalized-name circle
const NORM_LABEL_X = 432;  // x where normalized label starts
const NODE_R = 5;          // circle radius
const SVG_WIDTH = 700;

/**
 * Render an SVG bipartite directed graph into `el`.
 *
 * Each cluster corresponds to one anonymized normalized name.
 * Original variants are on the left, normalized target on the right,
 * connected by bezier curves with arrowheads.
 *
 * Hovering a cluster highlights it and dims the others.
 *
 * @param {HTMLElement} el
 * @param {Array<{norm:string, originals:string[], color:string, count:number}>} data
 */
function renderGraph(el, data) {
  const NS = 'http://www.w3.org/2000/svg';

  // Compute vertical layout
  const clusters = data.map((d) => {
    const rows = Math.max(d.originals.length, 1);
    return { ...d, rows };
  });

  let y = GROUP_GAP;
  const layout = clusters.map((c) => {
    const normY = y + (c.rows * ROW_H) / 2;
    const origYs = c.originals.map((_, j) => y + j * ROW_H + ROW_H / 2);
    const item = { ...c, normY, origYs, startY: y };
    y += c.rows * ROW_H + GROUP_GAP;
    return item;
  });
  const totalH = y;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(SVG_WIDTH));
  svg.setAttribute('height', String(totalH));
  svg.setAttribute('viewBox', `0 0 ${SVG_WIDTH} ${totalH}`);
  svg.style.fontFamily = 'inherit';
  svg.style.display = 'block';

  // Arrow marker defs (one per color so each cluster has its own arrow head)
  const defs = document.createElementNS(NS, 'defs');
  const usedColors = new Set();
  for (const item of layout) {
    if (usedColors.has(item.color)) continue;
    usedColors.add(item.color);
    const markerId = `arrow-${item.color.replace('#', '')}`;
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', markerId);
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3.5');
    marker.setAttribute('orient', 'auto');
    const tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', 'M0,0 L0,7 L7,3.5 z');
    tri.setAttribute('fill', item.color);
    marker.appendChild(tri);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // Per-cluster groups so hover can target the whole cluster at once
  const groups = [];
  for (const item of layout) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'names-cluster');
    g.dataset.norm = item.norm;
    groups.push(g);

    const markerId = `url(#arrow-${item.color.replace('#', '')})`;

    // --- Edges ---
    for (let j = 0; j < item.origYs.length; j++) {
      const oy = item.origYs[j];
      const ny = item.normY;
      const cpX1 = NODE_ORIG_X + (NODE_NORM_X - NODE_ORIG_X) * 0.35;
      const cpX2 = NODE_ORIG_X + (NODE_NORM_X - NODE_ORIG_X) * 0.65;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute(
        'd',
        `M${NODE_ORIG_X + NODE_R},${oy} C${cpX1},${oy} ${cpX2},${ny} ${NODE_NORM_X - NODE_R - 6},${ny}`,
      );
      path.setAttribute('stroke', item.color);
      path.setAttribute('stroke-width', '1.4');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.5');
      path.setAttribute('marker-end', markerId);
      g.appendChild(path);
    }

    // --- Original name nodes ---
    for (let j = 0; j < item.originals.length; j++) {
      const oy = item.origYs[j];

      const circ = document.createElementNS(NS, 'circle');
      circ.setAttribute('cx', String(NODE_ORIG_X));
      circ.setAttribute('cy', String(oy));
      circ.setAttribute('r', String(NODE_R - 1));
      circ.setAttribute('fill', item.color);
      circ.setAttribute('opacity', '0.75');
      g.appendChild(circ);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', String(ORIG_X));
      label.setAttribute('y', String(oy + 4));
      label.setAttribute('font-size', '12');
      label.setAttribute('fill', 'var(--text-secondary)');
      label.setAttribute('font-family', 'monospace');
      const rawCount = item.rawAssetCounts?.[j] ?? 0;
      label.textContent = `${item.originals[j]} (${rawCount})`;
      g.appendChild(label);
    }

    // --- Normalized name node ---
    const normCirc = document.createElementNS(NS, 'circle');
    normCirc.setAttribute('cx', String(NODE_NORM_X));
    normCirc.setAttribute('cy', String(item.normY));
    normCirc.setAttribute('r', String(NODE_R + 1));
    normCirc.setAttribute('fill', item.color);
    g.appendChild(normCirc);

    const normLabel = document.createElementNS(NS, 'text');
    normLabel.setAttribute('x', String(NORM_LABEL_X));
    normLabel.setAttribute('y', String(item.normY + 4));
    normLabel.setAttribute('font-size', '13');
    normLabel.setAttribute('fill', 'var(--text-primary)');
    normLabel.setAttribute('font-weight', '500');
    normLabel.textContent = `${item.norm} (${item.normAssetCount})`;
    g.appendChild(normLabel);

    svg.appendChild(g);
  }

  el.appendChild(svg);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Create and return the names view element.
 *
 * @param {object} coordinator - Mosaic coordinator with a `.query(sql)` method.
 * @returns {HTMLElement}
 */
export function createNamesView(coordinator) {
  const container = document.createElement('div');
  container.className = 'names-view';
  container.innerHTML = `
    <div class="names-header">
      <h2>Experimenter Name Normalization</h2>
      <p class="names-subtitle">
        Each node on the left is a raw name variant as it appears in the data.
        Arrows point to its normalized form on the right.
        Hover a cluster to highlight it.
      </p>
    </div>
    <div id="names-loading" class="loading-message">Querying DuckDB…</div>
    <div id="names-graph-container" class="names-graph-container" style="display:none">
      <div id="names-stats" class="names-stats"></div>
      <div class="names-body">
        <div class="names-sidebar">
          <h3 class="names-sidebar-title">All raw names</h3>
          <ul id="names-raw-list" class="names-raw-list"></ul>
        </div>
        <div id="names-graph" class="names-graph-scroll"></div>
      </div>
    </div>
  `;

  _load(container, coordinator);
  return container;
}

async function _load(container, coordinator) {
  const loadingEl = container.querySelector('#names-loading');
  const graphContainer = container.querySelector('#names-graph-container');

  try {
    const result = await coordinator.query(`
      SELECT
        array_to_string(experimenters, ',') AS experimenters,
        array_to_string(experimenters_normalized, ',') AS experimenters_normalized
      FROM asset_basics
      WHERE experimenters IS NOT NULL
        AND experimenters_normalized IS NOT NULL
        AND len(experimenters) > 0
        AND len(experimenters_normalized) > 0
    `);
    const rows = arrowTableToRows(result);

    const mapping = buildMapping(rows);
    const normalizedNames = [...mapping.normToRaws.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));

    if (normalizedNames.length === 0) {
      loadingEl.textContent = 'No experimenter normalization data found in asset_basics.';
      return;
    }

    // Build view data with character-substitution anonymization
    const viewData = normalizedNames.map((norm, i) => {
      const originals = [...mapping.normToRaws.get(norm)].sort((a, b) => a.localeCompare(b));
      return {
        norm,
        originals,
        color: PALETTE[i % PALETTE.length],
        count: originals.length,
        normAssetCount: mapping.normCounts.get(norm) ?? 0,
        rawAssetCounts: originals.map((o) => mapping.rawCounts.get(o) ?? 0),
      };
    });

    // Sort clusters alphabetically by normalized name
    viewData.sort((a, b) => a.norm.localeCompare(b.norm));

    loadingEl.remove();
    graphContainer.style.display = '';

    const statsEl = container.querySelector('#names-stats');
    const totalVariants = viewData.reduce((s, d) => s + d.originals.length, 0);
    statsEl.innerHTML = `
      <span>${escHtml(String(normalizedNames.length))} normalized identities</span>
      <span>${escHtml(String(totalVariants))} raw name variants</span>
    `;

    // Populate sidebar: all unique raw names across all clusters, sorted alpha
    const rawCountMap = new Map(viewData.flatMap((d) => d.originals.map((o, i) => [o, d.rawAssetCounts[i]])));
    const allRaw = [...new Set(viewData.flatMap((d) => d.originals))].sort((a, b) => a.localeCompare(b));
    const rawList = container.querySelector('#names-raw-list');
    rawList.innerHTML = allRaw.map((n) => `<li>${escHtml(n)} <span class="names-count">(${rawCountMap.get(n) ?? 0})</span></li>`).join('');

    renderGraph(container.querySelector('#names-graph'), viewData);
  } catch (err) {
    console.error('[Names] Failed to load:', err);
    loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
    loadingEl.className = 'loading-message error';
  }
}
