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
        fields.push([k, `${v.object_type}: ${v.name}${v.model ? ' (' + v.model + ')' : ''}`]);
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

  return `
    <div class="inst-device-card" data-device-name="${esc(name)}" style="--device-color: ${color}">
      <div class="inst-device-header">
        <span class="inst-device-type">${esc(type)}</span>
        ${acqBadge}
      </div>
      <div class="inst-device-name">${esc(name)}</div>
      <dl class="inst-device-fields">${fieldsHtml}</dl>
      ${acqHtml}
      ${notesHtml}
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

  // Non-positioned devices: standard grid
  const unpositionedHtml = unpositioned.length
    ? `<div class="inst-devices-grid">${unpositioned.map(({ dev, index }) =>
        buildDeviceCardHtml(dev, index, acqConfigsByDevice)
      ).join('')}</div>`
    : '';

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

  // Connections
  const connections = instrumentData.connections ?? [];
  const connectionsHtml = connections.length
    ? `<div class="inst-connections">
        <h4>Connections</h4>
        <table class="detail-table">
          <thead><tr>
            <th>Source</th><th>Port</th><th></th><th>Target</th><th>Port</th><th>Bidirectional</th>
          </tr></thead>
          <tbody>${connections.map(conn => `<tr>
            <td>${esc(conn.source_device)}</td>
            <td>${esc(conn.source_port ?? '')}</td>
            <td class="inst-conn-arrow">${conn.send_and_receive ? '⇄' : '→'}</td>
            <td>${esc(conn.target_device)}</td>
            <td>${esc(conn.target_port ?? '')}</td>
            <td>${conn.send_and_receive ? 'Yes' : 'No'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>`
    : '';

  container.innerHTML = `${headerHtml}
    ${unpositionedHtml}
    ${positionedHtml}
    ${connectionsHtml}`;

  return container;
}
