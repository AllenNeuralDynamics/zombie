/**
 * instrument-view.js — Instrument detail panel for the subject details view.
 *
 * Renders instrument components as device cards with their details,
 * links acquisition device configs to matching instrument devices,
 * and shows connections between devices.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtVal(v) {
  if (v == null || v === '') return '<span class="inst-na">—</span>';
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}

/** Flatten a device object into display-friendly key/value pairs. */
function deviceFields(device) {
  const skip = new Set([
    'object_type', 'name', 'additional_settings', 'notes',
    'manufacturer', 'describedBy', 'schema_version',
  ]);
  const fields = [];

  // Always show manufacturer + model first
  const mfr = device.manufacturer;
  if (mfr) {
    fields.push(['Manufacturer', mfr.name ?? mfr.abbreviation ?? '']);
  }
  if (device.model != null) fields.push(['Model', device.model]);
  if (device.serial_number != null) fields.push(['Serial #', device.serial_number]);

  // Iterate remaining keys
  for (const [k, v] of Object.entries(device)) {
    if (skip.has(k) || k === 'model' || k === 'serial_number') continue;
    if (v == null || v === '') continue;

    // Skip nested objects that are already displayed (like manufacturer)
    if (typeof v === 'object' && !Array.isArray(v)) {
      // Show sub-devices inline (e.g. camera in Camera assembly, manipulator in Ephys assembly)
      if (v.object_type && v.name) {
        fields.push([k, `${v.name}${v.model ? ' (' + v.model + ')' : ''}`]);
      }
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      // Simple scalar arrays
      if (typeof v[0] !== 'object') {
        fields.push([k, v.join(', ')]);
      }
      continue;
    }
    fields.push([k, v]);
  }
  return fields;
}

/** Build a class name suffix from the device type. */
function deviceTypeClass(objectType) {
  return (objectType ?? 'device').toLowerCase().replace(/\s+/g, '-');
}

// ---------------------------------------------------------------------------
// Colour palette for device type groups
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
  'laser':                 '#e74c3c',
  'detector':              '#3498db',
  'camera':                '#2ecc71',
  'camera-assembly':       '#27ae60',
  'objective':             '#9b59b6',
  'lens':                  '#8e44ad',
  'microscope':            '#e67e22',
  'monitor':               '#1abc9c',
  'daq-device':            '#f39c12',
  'disc':                  '#95a5a6',
  'ephys-assembly':        '#e74c3c',
  'neuropixels-basestation': '#c0392b',
  'harp-device':           '#d35400',
  'additional-imaging-device': '#16a085',
  'speaker':               '#7f8c8d',
  'filter':                '#2c3e50',
  'wheel':                 '#bdc3c7',
  'light-emitting-diode':  '#f1c40f',
  'lick-spout-assembly':   '#1abc9c',
  'computer':              '#34495e',
  'olfactometer':          '#e91e63',
};

function deviceColor(objectType) {
  const key = deviceTypeClass(objectType);
  return TYPE_COLORS[key] ?? '#7f8c8d';
}

// ---------------------------------------------------------------------------
// Positioning helpers
// ---------------------------------------------------------------------------

/**
 * Get the relative_position array from a device (may be on the device directly,
 * or nested inside a camera assembly's top-level or sub-object).
 */
function getRelativePosition(dev) {
  if (Array.isArray(dev.relative_position) && dev.relative_position.length) {
    return dev.relative_position;
  }
  // Camera assemblies sometimes store position at the top level
  if (dev.camera?.relative_position?.length) return dev.camera.relative_position;
  return null;
}

/**
 * Map relative_position labels to grid placement (top-down view).
 * Returns { row, col } where the spatial grid is 3×3:
 *   row: 0=Anterior(top), 1=centre, 2=Posterior(bottom)
 *   col: 0=Left, 1=centre, 2=Right
 * Superior/Inferior are treated as centre (vertical axis not shown top-down).
 */
function positionToGrid(relPos) {
  let row = 1, col = 1;
  for (const dir of relPos) {
    const d = dir.toLowerCase();
    if (d === 'anterior') row = 0;
    else if (d === 'posterior') row = 2;
    else if (d === 'left') col = 0;
    else if (d === 'right') col = 2;
    // Superior/Inferior don't change row/col for top-down
  }
  return { row, col };
}

/** Label for the grid cell based on directions. */
function positionLabel(relPos) {
  return relPos.join(', ');
}

// ---------------------------------------------------------------------------
// Card HTML builder (shared between positioned and non-positioned)
// ---------------------------------------------------------------------------

function buildDeviceCardHtml(dev, index, acqConfigsByDevice) {
  const name = dev.name ?? `Device ${index + 1}`;
  const type = dev.object_type ?? 'Device';
  const color = deviceColor(type);
  const fields = deviceFields(dev);

  const acqConfigs = acqConfigsByDevice.get(name) ?? [];
  const acqBadge = acqConfigs.length
    ? `<span class="inst-acq-badge" title="Linked to ${acqConfigs.length} acquisition config(s)">⚡ Active</span>`
    : '';

  const fieldsHtml = fields
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${fmtVal(v)}</dd>`)
    .join('');

  const acqHtml = acqConfigs.length
    ? `<div class="inst-acq-configs">
        <strong>Acquisition Config:</strong>
        ${acqConfigs.map(cfg => `<span class="inst-acq-type">${esc(cfg.object_type ?? 'Config')}</span>`).join('')}
      </div>`
    : '';

  const notesHtml = dev.notes
    ? `<div class="inst-device-notes">${esc(dev.notes)}</div>`
    : '';

  // Build tooltip content (all details)
  const tooltipContent = `<dl class="inst-device-fields">${fieldsHtml}</dl>${acqHtml}${notesHtml}`;

  return `
    <div class="inst-device-card" data-device-name="${esc(name)}" style="--device-color: ${color}">
      <div class="inst-device-header">
        <span class="inst-device-type">${esc(type)}</span>
        <button class="inst-info-btn" title="Show details" aria-label="Show details for ${esc(name)}">?</button>
      </div>
      <div class="inst-device-name">${esc(name)}</div>
      <div class="inst-tooltip" role="tooltip">${tooltipContent}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Connections SVG graph
// ---------------------------------------------------------------------------

function buildConnectionsGraphHtml(connections, components) {
  if (!connections || !connections.length) return '';

  // Build device-type lookup for coloring
  const compTypes = new Map();
  for (const c of (components ?? [])) {
    if (c.name && c.object_type) compTypes.set(c.name, c.object_type);
  }
  const colorFor = (name) => deviceColor(compTypes.get(name));

  // Layout constants
  const PORT_H   = 22;   // vertical space per port slot inside a node
  const NODE_PAD = 8;    // top/bottom padding inside a node
  const NODE_MIN = 32;   // minimum node height when no named ports
  const NODE_W   = 170;
  const V_GAP    = 10;   // gap between stacked nodes
  const MID_GAP  = 140;  // horizontal corridor for bezier curves
  const PAD      = 10;

  const COL_LEFT  = PAD;
  const COL_RIGHT = COL_LEFT + NODE_W + MID_GAP;
  const SVG_W     = COL_RIGHT + NODE_W + PAD;

  // --- First pass: collect unique ports per device (in connection order) ---
  // srcPorts / tgtPorts: device → ordered array of port keys (null = unnamed)
  const srcPorts  = new Map();  // device → [port, ...]
  const tgtPorts  = new Map();
  const srcOrder  = [];
  const tgtOrder  = [];

  for (const conn of connections) {
    const s = conn.source_device;
    const t = conn.target_device;
    const sp = conn.source_port ?? null;
    const tp = conn.target_port ?? null;

    if (!srcPorts.has(s)) { srcPorts.set(s, []); srcOrder.push(s); }
    if (!tgtPorts.has(t)) { tgtPorts.set(t, []); tgtOrder.push(t); }

    if (!srcPorts.get(s).includes(sp)) srcPorts.get(s).push(sp);
    if (!tgtPorts.get(t).includes(tp)) tgtPorts.get(t).push(tp);
  }

  // Node height = padding + one row per named port (or 1 row minimum)
  const nodeH = (ports) => {
    const rows = ports.length === 1 && ports[0] === null ? 1 : ports.length;
    return Math.max(NODE_MIN, NODE_PAD * 2 + rows * PORT_H);
  };

  // --- Second pass: compute top-Y for each device ---
  const srcY = new Map();
  const tgtY = new Map();

  let y = PAD;
  for (const dev of srcOrder) { srcY.set(dev, y); y += nodeH(srcPorts.get(dev)) + V_GAP; }
  const srcTotalH = y;

  y = PAD;
  for (const dev of tgtOrder) { tgtY.set(dev, y); y += nodeH(tgtPorts.get(dev)) + V_GAP; }
  const tgtTotalH = y;

  const totalH = Math.max(srcTotalH, tgtTotalH) + PAD;

  // Centre-Y for a specific port within a node
  const portCY = (nodeTopY, ports, port) => {
    const idx = ports.indexOf(port);
    if (ports.length === 1 && ports[0] === null) {
      return nodeTopY + nodeH(ports) / 2;
    }
    return nodeTopY + NODE_PAD + idx * PORT_H + PORT_H / 2;
  };

  // --- Arrow marker defs ---
  // refX=0: base of arrowhead at path endpoint; tip extends 7px forward into the node.
  const usedColors = new Set([...srcOrder].map(colorFor));
  let defs = '';
  for (const col of usedColors) {
    const id = col.replace('#', '');
    defs += `<marker id="ica-${id}" markerWidth="7" markerHeight="7" refX="0" refY="3.5" orient="auto">
      <path d="M0,0 L0,7 L7,3.5 z" fill="${col}"/>
    </marker>
    <marker id="ica-r-${id}" markerWidth="7" markerHeight="7" refX="0" refY="3.5" orient="auto-start-reverse">
      <path d="M0,0 L0,7 L7,3.5 z" fill="${col}"/>
    </marker>`;
  }

  // --- Edges (drawn before nodes so nodes sit on top) ---
  const x1 = COL_LEFT + NODE_W;
  const x2 = COL_RIGHT;
  let edges = '';
  let portLabels = '';  // drawn after nodes so they're always visible
  const drawnSrcLabels = new Set();
  const drawnTgtLabels = new Set();

  for (const conn of connections) {
    const sp  = conn.source_port ?? null;
    const tp  = conn.target_port ?? null;
    const col = colorFor(conn.source_device);
    const id  = col.replace('#', '');
    const sy  = portCY(srcY.get(conn.source_device), srcPorts.get(conn.source_device), sp);
    const ty  = portCY(tgtY.get(conn.target_device), tgtPorts.get(conn.target_device), tp);
    const mEnd = `marker-end="url(#ica-${id})"`;

    // For bidirectional: start path 7px into the corridor so the reverse arrowhead tip
    // lands right at x1 (the source node right edge) without being hidden under the white rect.
    const pathX1 = conn.send_and_receive ? x1 + 7 : x1;
    const pathX2 = x2 - 7;  // forward arrowhead tip lands at x2
    const pdx    = pathX2 - pathX1;
    const mStart = conn.send_and_receive ? `marker-start="url(#ica-r-${id})"` : '';

    edges += `<path d="M${pathX1},${sy} C${pathX1 + pdx * 0.42},${sy} ${pathX1 + pdx * 0.58},${ty} ${pathX2},${ty}" stroke="${col}" stroke-width="1.4" fill="none" opacity="0.6" ${mStart} ${mEnd}/>`;

    // Port labels inside the cards, drawn after nodes so they're never covered.
    // Source side: right-anchored just inside the right edge of the source card.
    const srcKey = `${conn.source_device}::${sp}`;
    if (sp && !drawnSrcLabels.has(srcKey)) {
      drawnSrcLabels.add(srcKey);
      portLabels += `<text x="${x1 - 6}" y="${sy + 4}" font-size="9" fill="${col}" font-family="monospace" text-anchor="end" opacity="0.9">${esc(sp)}</text>`;
    }
    // Target side: left-anchored just inside the left edge of the target card.
    const tgtKey = `${conn.target_device}::${tp}`;
    if (tp && !drawnTgtLabels.has(tgtKey)) {
      drawnTgtLabels.add(tgtKey);
      portLabels += `<text x="${x2 + 6}" y="${ty + 4}" font-size="9" fill="${col}" font-family="monospace" opacity="0.9">${esc(tp)}</text>`;
    }
  }

  // --- Source nodes ---
  let srcNodes = '';
  for (const dev of srcOrder) {
    const col   = colorFor(dev);
    const ty    = srcY.get(dev);
    const ports = srcPorts.get(dev);
    const h     = nodeH(ports);
    const label = dev.length > 23 ? dev.slice(0, 22) + '\u2026' : dev;
    srcNodes += `<rect x="${COL_LEFT}" y="${ty}" width="${NODE_W}" height="${h}" rx="3" fill="white" stroke="${col}" stroke-width="1.5"/>`;
    srcNodes += `<text x="${COL_LEFT + 8}" y="${ty + h / 2 + 4}" font-size="11" fill="#1a1a2e" font-family="inherit" font-weight="500">${esc(label)}</text>`;
    // Connection dots on right edge
    for (const port of ports) {
      if (port === null) continue;
      const cy = portCY(ty, ports, port);
      srcNodes += `<circle cx="${x1}" cy="${cy}" r="3" fill="${col}"/>`;
    }
  }

  // --- Target nodes ---
  let tgtNodes = '';
  for (const dev of tgtOrder) {
    const col   = colorFor(dev);
    const ty    = tgtY.get(dev);
    const ports = tgtPorts.get(dev);
    const h     = nodeH(ports);
    const label = dev.length > 23 ? dev.slice(0, 22) + '\u2026' : dev;
    tgtNodes += `<rect x="${COL_RIGHT}" y="${ty}" width="${NODE_W}" height="${h}" rx="3" fill="white" stroke="${col}" stroke-width="1.5"/>`;
    // Name is right-anchored so port labels on the left don't collide with it
    tgtNodes += `<text x="${COL_RIGHT + NODE_W - 8}" y="${ty + h / 2 + 4}" font-size="11" fill="#1a1a2e" font-family="inherit" font-weight="500" text-anchor="end">${esc(label)}</text>`;
    // Connection dots on left edge
    for (const port of ports) {
      if (port === null) continue;
      const cy = portCY(ty, ports, port);
      tgtNodes += `<circle cx="${x2}" cy="${cy}" r="3" fill="${col}"/>`;
    }
  }

  return `<div class="inst-connections">
    <h4>Connections</h4>
    <div class="inst-conn-graph">
      <svg width="${SVG_W}" height="${totalH}" viewBox="0 0 ${SVG_W} ${totalH}" style="font-family: inherit; display: block; overflow: visible;">
        <defs>${defs}</defs>
        ${edges}
        ${srcNodes}
        ${tgtNodes}
        ${portLabels}
      </svg>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Build instrument device cards
// ---------------------------------------------------------------------------

/**
 * Create the instrument detail panel.
 *
 * @param {object} instrumentData - Raw instrument object from the metadata record.
 * @param {object} [acquisitionData] - Raw acquisition object (to link device configs).
 * @returns {HTMLElement}
 */
export function createInstrumentPanel(instrumentData, acquisitionData = null) {
  const container = document.createElement('div');
  container.className = 'instrument-panel';

  if (!instrumentData?.components?.length) {
    container.innerHTML = '<p class="detail-empty">No instrument data available.</p>';
    return container;
  }

  // Build a map of acquisition device configs by device_name
  const acqConfigsByDevice = new Map();
  if (acquisitionData) {
    for (const stream of (acquisitionData.data_streams ?? [])) {
      for (const cfg of (stream.configurations ?? [])) {
        if (cfg?.device_name) {
          if (!acqConfigsByDevice.has(cfg.device_name)) {
            acqConfigsByDevice.set(cfg.device_name, []);
          }
          acqConfigsByDevice.get(cfg.device_name).push(cfg);
        }
      }
    }
  }

  // Header info
  const headerHtml = `
    <div class="detail-card">
      <h4>Instrument: ${esc(instrumentData.instrument_id ?? 'Unknown')}</h4>
      <dl>
        ${instrumentData.location ? `<dt>Location</dt><dd>${esc(instrumentData.location)}</dd>` : ''}
        ${instrumentData.modalities?.length
          ? `<dt>Modalities</dt><dd>${instrumentData.modalities.map(m => esc(m.name ?? m.abbreviation)).join(', ')}</dd>`
          : ''}
        ${instrumentData.modification_date ? `<dt>Last modified</dt><dd>${esc(instrumentData.modification_date)}</dd>` : ''}
        ${instrumentData.notes ? `<dt>Notes</dt><dd>${esc(instrumentData.notes)}</dd>` : ''}
      </dl>
    </div>`;

  // Split components into positioned and non-positioned
  const components = instrumentData.components ?? [];
  const positioned = [];
  const unpositioned = [];
  for (let i = 0; i < components.length; i++) {
    const dev = components[i];
    const relPos = getRelativePosition(dev);
    if (relPos) {
      positioned.push({ dev, index: i, relPos });
    } else {
      unpositioned.push({ dev, index: i });
    }
  }

  // Positioned devices: spatial top-down layout (3×3 grid)
  let positionedHtml = '';
  if (positioned.length) {
    // Build 3×3 grid cells
    // Grid cells: [row][col] where row 0=anterior, 1=center, 2=posterior; col 0=left, 1=center, 2=right
    const grid = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => []));
    for (const { dev, index, relPos } of positioned) {
      const { row, col } = positionToGrid(relPos);
      grid[row][col].push(buildDeviceCardHtml(dev, index, acqConfigsByDevice));
    }

    const rowLabels = ['Anterior', '', 'Posterior'];
    const colLabels = ['Left', '', 'Right'];

    // Build grid HTML
    let gridCells = '';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cards = grid[r][c].join('');
        const label = (r === 1 && c === 1) ? 'Centre'
          : [rowLabels[r], colLabels[c]].filter(Boolean).join(' / ');
        const labelHtml = cards ? `<div class="inst-pos-label">${esc(label)}</div>` : '';
        gridCells += `<div class="inst-pos-cell" data-row="${r}" data-col="${c}">${labelHtml}${cards}</div>`;
      }
    }

    positionedHtml = `
      <div class="inst-positioned-section">
        <h4>Positioned Devices <span class="inst-pos-hint">(top-down view)</span></h4>
        <div class="inst-pos-grid">
          <div class="inst-pos-compass">
            <span class="inst-pos-compass-n">A</span>
            <span class="inst-pos-compass-s">P</span>
            <span class="inst-pos-compass-w">L</span>
            <span class="inst-pos-compass-e">R</span>
          </div>
          ${gridCells}
        </div>
      </div>`;
  }

  // Non-positioned devices: standard grid
  const unpositionedHtml = unpositioned.length
    ? `<div class="inst-unpositioned-section">
        <h4>Devices</h4>
        <div class="inst-devices-grid">${unpositioned.map(({ dev, index }) =>
          buildDeviceCardHtml(dev, index, acqConfigsByDevice)
        ).join('')}</div>
      </div>`
    : '';

  // Connections
  const connections = instrumentData.connections ?? [];
  const connectionsHtml = buildConnectionsGraphHtml(connections, instrumentData.components);

  container.innerHTML = `${headerHtml}
    <div class="inst-main-layout">
      ${positionedHtml}
      ${unpositionedHtml}
    </div>
    ${connectionsHtml}`;

  return container;
}
