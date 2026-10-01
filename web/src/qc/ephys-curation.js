import { decodeReferenceUrl, parseCurationValues } from './data.js';

const EPHYS_HOST = 'ephys.allenneuraldynamics.org';
const EPHYS_SAFE_URL_CHARS = new Set(':/?&=-');

export function isEphysReference(reference) {
  return decodeReferenceUrl(reference).toLowerCase().includes(EPHYS_HOST);
}

export function isEphysCurationMetric(metric) {
  if (!metric || !isEphysReference(metric.reference)) return false;
  return metric.object_type === 'Curation metric' || metric.type === 'Spike sorting curation';
}

function normalizeS3Location(location) {
  const value = String(location ?? '').trim();
  if (!value) return '';
  return value.startsWith('s3://') ? value : `s3://${value.replace(/^s3:\/\//, '')}`;
}

/** Match Python's quote(..., safe=':/?&=-') used by the original portal. */
export function quoteEphysUrl(value) {
  return [...String(value ?? '')]
    .map(character => {
      if (/[A-Za-z0-9_.~-]/.test(character) || EPHYS_SAFE_URL_CHARS.has(character)) return character;
      return encodeURIComponent(character);
    })
    .join('');
}

/**
 * Resolve the encoded ephys GUI reference used by Spike sorting curation
 * metrics. The GUI expects the derived/raw locations plus the per-iframe
 * identifier and session query parameters before it starts.
 */
export function buildEphysCurationUrl(reference, {
  s3Bucket = '',
  s3Prefix = '',
  rawS3Loc = '',
  identifier = '',
} = {}) {
  if (!reference) return '';

  let processed = decodeReferenceUrl(reference);
  processed = processed.replace(/\{derived_asset_location\}/g, `s3://${s3Bucket}/${s3Prefix}`);
  processed = processed.replace(/\{raw_asset_location\}/g, normalizeS3Location(rawS3Loc));

  const separator = processed.includes('?') ? '&' : '?';
  processed += `${separator}identifier=${identifier}&session=${s3Prefix}`;
  return quoteEphysUrl(processed);
}

export function createEphysIdentifier() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `ephys-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function historyLabel(index, history) {
  const entry = history[index];
  if (!entry) return `Curation ${index}`;
  const curator = entry.curator ?? 'Unknown';
  const timestamp = String(entry.timestamp ?? '').split('.')[0];
  return `${curator} - ${timestamp}`;
}

function formatCurationData(data) {
  try { return JSON.stringify(data ?? {}, null, 2); } catch { return String(data ?? ''); }
}

function postToIframe(iframe, message) {
  try {
    iframe.contentWindow?.postMessage(message, '*');
  } catch (error) {
    console.warn('[qc-ephys] postMessage failed', error);
  }
}

/**
 * Render the interactive ephys curation panel used by the legacy QC Portal.
 *
 * The returned element owns one iframe/message listener pair. `qcDestroy()` is
 * attached for callers that replace the surrounding QC view.
 */
export function renderEphysCuration(metric, {
  s3Bucket = '',
  s3Prefix = '',
  assetName = '',
  rawS3Loc = '',
  edit = {},
  identifier = createEphysIdentifier(),
} = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'qc-ephys-curation';
  wrapper.dataset.qcEphysIdentifier = identifier;

  const history = Array.isArray(metric.curation_history) ? metric.curation_history : [];
  const sourceValues = parseCurationValues(metric.value);
  const pendingDraft = edit.enabled && edit.curationDrafts &&
    Object.prototype.hasOwnProperty.call(edit.curationDrafts, metric.name)
    ? edit.curationDrafts[metric.name]
    : undefined;
  const values = sourceValues.length ? [...sourceValues] : [{}];
  if (pendingDraft !== undefined) values.push(pendingDraft);

  let selectedIndex = values.length - 1;

  const controls = document.createElement('div');
  controls.className = 'qc-ephys-curation-controls';

  const pickerLabel = document.createElement('label');
  pickerLabel.className = 'qc-ephys-curation-picker';
  pickerLabel.appendChild(document.createTextNode('Select curation'));
  const picker = document.createElement('select');
  picker.className = 'qc-ephys-curation-select';
  picker.setAttribute('aria-label', `${metric.name ?? 'Ephys'} curation history`);
  pickerLabel.appendChild(picker);
  controls.appendChild(pickerLabel);

  const metadata = document.createElement('div');
  metadata.className = 'qc-ephys-curation-metadata';
  controls.appendChild(metadata);

  const json = document.createElement('pre');
  json.className = 'qc-ephys-curation-json';
  controls.appendChild(json);

  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'qc-ephys-curation-send';
  sendButton.textContent = 'Send curation';
  controls.appendChild(sendButton);

  const frame = document.createElement('div');
  frame.className = 'qc-ephys-curation-frame';
  const iframe = document.createElement('iframe');
  iframe.className = 'qc-ephys-curation-iframe';
  iframe.setAttribute('aria-label', `${metric.name ?? 'Ephys'} curation GUI`);
  iframe.setAttribute('allowfullscreen', '');
  iframe.setAttribute('allow', 'cross-origin-isolated');
  iframe.src = buildEphysCurationUrl(metric.reference, {
    s3Bucket,
    s3Prefix,
    rawS3Loc,
    identifier,
  });
  frame.appendChild(iframe);

  const fullscreenButton = document.createElement('button');
  fullscreenButton.type = 'button';
  fullscreenButton.className = 'qc-ephys-curation-fullscreen';
  fullscreenButton.setAttribute('aria-label', 'Open ephys GUI full screen');
  fullscreenButton.textContent = '⛶';
  const onFullscreenClick = () => {
    if (frame.requestFullscreen) frame.requestFullscreen();
  };
  fullscreenButton.addEventListener('click', onFullscreenClick);
  frame.appendChild(fullscreenButton);

  wrapper.appendChild(controls);
  wrapper.appendChild(frame);

  const updateDisplay = () => {
    const data = values[selectedIndex] ?? {};
    const isPending = selectedIndex >= history.length;
    picker.value = String(selectedIndex);
    metadata.textContent = isPending ? 'Pending curation' : historyLabel(selectedIndex, history);
    json.textContent = formatCurationData(data);
  };

  const populatePicker = () => {
    picker.replaceChildren();
    values.forEach((_, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = index >= history.length ? 'Pending curation' : historyLabel(index, history);
      picker.appendChild(option);
    });
    updateDisplay();
  };

  const onPickerChange = () => {
    selectedIndex = Number(picker.value);
    updateDisplay();
  };

  const onSend = () => {
    const envelope = {
      type: 'curation-data',
      identifier,
      data: values[selectedIndex] ?? {},
      _nonce: createEphysIdentifier(),
    };
    postToIframe(iframe, envelope);
  };

  const onMessage = event => {
    const data = event.data;
    if (!data || data.source === 'react-devtools-content-script') return;
    if (data.type !== 'curation-data' || data.identifier !== identifier) return;
    if (event.source && iframe.contentWindow && event.source !== iframe.contentWindow) return;
    if (!data.data || typeof data.data !== 'object' || Array.isArray(data.data)) return;

    values.push(data.data);
    selectedIndex = values.length - 1;
    populatePicker();
    if (edit.enabled) edit.onCuration?.(metric.name, data.data);
  };

  const onFullscreenChange = () => {
    if (document.fullscreenElement === frame || !document.fullscreenElement) {
      setTimeout(() => postToIframe(iframe, { type: 'fullscreen-resize' }), 200);
    }
  };

  picker.addEventListener('change', onPickerChange);
  sendButton.addEventListener('click', onSend);
  window.addEventListener('message', onMessage);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  populatePicker();

  wrapper.qcDestroy = () => {
    picker.removeEventListener('change', onPickerChange);
    sendButton.removeEventListener('click', onSend);
    fullscreenButton.removeEventListener('click', onFullscreenClick);
    window.removeEventListener('message', onMessage);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
  };
  // Keep the asset name in the DOM-owned component contract for callers that
  // need to identify the source while debugging without changing the URL.
  wrapper.dataset.qcEphysAsset = assetName;
  return wrapper;
}
