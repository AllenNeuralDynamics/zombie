import { html } from 'htm/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { QC_SPA_EDITOR_ENABLED } from '../constants.js';
import { getQcAccount, loginForQc } from '../lib/qc-spa-auth.js';
import { submitQcEdit } from './api.js';
import { canonicalQcJson, hashQc } from './canonical.js';
import { getMetricStatus, isCustomMetric, parseQCRecord } from './data.js';

const UNSUPPORTED_CURATION_TYPES = /spike\s*sorting|ephys/i;

function isEditableMetric(metric) {
  if (isCustomMetric(metric.value)) return false;
  if (metric.object_type === 'Curation metric' && UNSUPPORTED_CURATION_TYPES.test(metric.type ?? '')) return false;
  return true;
}

function valueText(value) {
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
  return value === null || value === undefined ? '' : String(value);
}

function parseDraft(text, original) {
  if (typeof original === 'number') {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) throw new Error('Enter a finite number.');
    return value;
  }
  if (typeof original === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('Enter true or false.');
    return text === 'true';
  }
  if (original !== null && typeof original === 'object') {
    try { return JSON.parse(text); } catch { throw new Error('Enter valid JSON.'); }
  }
  return text;
}

function sameValue(left, right) {
  try { return canonicalQcJson(left) === canonicalQcJson(right); } catch { return left === right; }
}

/** Build the narrow request body from already-reviewed local changes. */
export function buildQcSubmitPayload(record, {
  expectedQcHash,
  pendingChanges = {},
  notesChanged = false,
  notes = '',
} = {}) {
  const changes = Object.entries(pendingChanges).map(([metric_name, change]) => {
    const result = { metric_name };
    if (Object.prototype.hasOwnProperty.call(change, 'value')) result.value = change.value;
    if (Object.prototype.hasOwnProperty.call(change, 'status')) result.status = change.status;
    return result;
  });
  const payload = {
    record_id: String(record._id),
    expected_qc_hash: expectedQcHash,
    changes,
  };
  if (notesChanged) payload.notes = notes;
  return payload;
}

function errorText(error) {
  if (!error) return '';
  if (error.status === 403) return 'Your account cannot edit QC from this page.';
  if (error.status === 409) return 'This record changed elsewhere. Review the current record before submitting again.';
  if (error.status === 422) return 'The QC server rejected this change because it does not match the QC schema.';
  if (error.status >= 500) return 'The QC editor is temporarily unavailable. Use Open QC Portal to edit.';
  return error.message || 'QC submission failed.';
}

function MetricEdit({ metric, draft, status, error, onValue, onStatus }) {
  const curation = metric.object_type === 'Curation metric';
  return html`
    <div class=${`qc-editor-metric ${curation ? 'qc-editor-curation' : ''}`}>
      <label class="qc-editor-label">${metric.name}</label>
      <textarea
        class="qc-editor-value"
        value=${draft}
        rows=${typeof metric.value === 'object' ? 4 : 1}
        onInput=${event => onValue(event.currentTarget.value)}
        aria-label=${`${metric.name} value`}
      />
      ${error ? html`<div class="qc-editor-field-error">${error}</div>` : null}
      <label class="qc-editor-status-label">
        Status
        <select value=${status} onChange=${event => onStatus(event.currentTarget.value)}>
          <option value="Pending">Pending</option>
          <option value="Pass">Pass</option>
          <option value="Fail">Fail</option>
        </select>
      </label>
      ${curation ? html`<small>Curation values append to the existing history.</small>` : null}
    </div>
  `;
}

export function QcEditor({ record, onReload }) {
  if (!QC_SPA_EDITOR_ENABLED) return null;
  const parsed = useMemo(() => parseQCRecord(record), [record]);
  const editableMetrics = parsed.metrics.filter(isEditableMetric);
  const [account, setAccount] = useState(null);
  const [authError, setAuthError] = useState('');
  const [valueDrafts, setValueDrafts] = useState(() => Object.fromEntries(
    editableMetrics.map(metric => [metric.name, valueText(metric.value)]),
  ));
  const [statusDrafts, setStatusDrafts] = useState(() => Object.fromEntries(
    editableMetrics.map(metric => [metric.name, getMetricStatus(metric)]),
  ));
  const [fieldErrors, setFieldErrors] = useState({});
  const [notes, setNotes] = useState(parsed.notes);
  const [preview, setPreview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let alive = true;
    getQcAccount().then(value => {
      if (alive) setAccount(value);
    }).catch(() => {
      if (alive) setAuthError('Entra login is not configured for this deployment.');
    });
    return () => { alive = false; };
  }, []);

  const pendingChanges = {};
  for (const metric of editableMetrics) {
    const originalValue = metric.value;
    const originalStatus = getMetricStatus(metric);
    const valueChanged = fieldErrors[metric.name] === undefined &&
      !sameValue(parseDraft(valueDrafts[metric.name], originalValue), originalValue);
    const statusChanged = statusDrafts[metric.name] !== originalStatus;
    if (valueChanged || statusChanged) {
      pendingChanges[metric.name] = {};
      if (valueChanged) pendingChanges[metric.name].value = parseDraft(valueDrafts[metric.name], originalValue);
      if (statusChanged) pendingChanges[metric.name].status = statusDrafts[metric.name];
    }
  }
  const notesChanged = notes !== parsed.notes;
  const changeCount = Object.keys(pendingChanges).length + (notesChanged ? 1 : 0);

  const handleValue = (metric, value) => {
    setValueDrafts(previous => ({ ...previous, [metric.name]: value }));
    try {
      parseDraft(value, metric.value);
      setFieldErrors(previous => ({ ...previous, [metric.name]: undefined }));
    } catch (error) {
      setFieldErrors(previous => ({ ...previous, [metric.name]: error.message }));
    }
  };

  const handleLogin = async () => {
    setMessage('');
    try { await loginForQc(); } catch (error) { setMessage(errorText(error)); }
  };

  const handleSubmit = async () => {
    if (!changeCount || Object.values(fieldErrors).some(Boolean)) return;
    setSubmitting(true);
    setMessage('');
    try {
      const expectedQcHash = await hashQc(record.quality_control);
      const payload = buildQcSubmitPayload(record, { expectedQcHash, pendingChanges, notesChanged, notes });
      await submitQcEdit(payload);
      try {
        await onReload();
        setMessage('QC changes applied and reloaded.');
      } catch {
        setMessage('The server may have applied the change, but reload failed. Use Open QC Portal to verify.');
      }
      setPreview(false);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (!account) {
    return html`
      <section class="qc-editor qc-editor-readonly">
        <h3>QC editor</h3>
        <p>${message || authError || 'Log in with your AIND account to edit QC.'}</p>
        <button class="qc-edit-btn" onClick=${handleLogin}>Log in to edit QC</button>
        <p class="qc-editor-fallback">You can always use Open QC Portal above.</p>
      </section>
    `;
  }

  return html`
    <section class="qc-editor">
      <div class="qc-editor-heading">
        <div>
          <h3>Edit QC</h3>
          <small>Signed in as ${account.username || account.name || account.homeAccountId}</small>
        </div>
        <button class="qc-editor-secondary" onClick=${() => setPreview(!preview)} disabled=${submitting}>
          ${preview ? 'Back to edit' : `Review changes (${changeCount})`}
        </button>
      </div>
      ${message ? html`<div class="qc-editor-message">${message}</div>` : null}
      ${preview ? html`
        <div class="qc-editor-preview">
          <h4>Review before submit</h4>
          ${changeCount ? html`<pre>${JSON.stringify({ changes: pendingChanges, notes: notesChanged ? notes : undefined }, null, 2)}</pre>` : html`<p>No changes to submit.</p>`}
          <button class="qc-edit-btn" onClick=${handleSubmit} disabled=${submitting || !changeCount}>
            ${submitting ? 'Submitting…' : 'Submit QC changes'}
          </button>
        </div>
      ` : html`
        <div class="qc-editor-metrics">
          ${editableMetrics.map(metric => html`
            <${MetricEdit}
              key=${metric.name}
              metric=${metric}
              draft=${valueDrafts[metric.name]}
              status=${statusDrafts[metric.name]}
              error=${fieldErrors[metric.name]}
              onValue=${value => handleValue(metric, value)}
              onStatus=${value => setStatusDrafts(previous => ({ ...previous, [metric.name]: value }))}
            />
          `)}
        </div>
        ${parsed.metrics.length !== editableMetrics.length ? html`<p class="qc-editor-fallback">Specialized/custom metrics remain read-only; use Open QC Portal for those.</p>` : null}
        <label class="qc-editor-label">Notes<textarea rows="3" value=${notes} onInput=${event => setNotes(event.currentTarget.value)} /></label>
        <button class="qc-edit-btn" onClick=${() => setPreview(true)} disabled=${!changeCount || Object.values(fieldErrors).some(Boolean)}>
          Review changes (${changeCount})
        </button>
      `}
    </section>
  `;
}

export function mountQcEditor(container, record, options = {}) {
  if (!QC_SPA_EDITOR_ENABLED) return () => {};
  render(html`<${QcEditor} record=${record} onReload=${options.onReload || (() => Promise.resolve())} />`, container);
  return () => render(null, container);
}
