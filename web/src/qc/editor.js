import { html } from 'htm/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { QC_SPA_EDITOR_ENABLED } from '../constants.js';
import { queryDocDb } from '../lib/docdb.js';
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

/**
 * Diff pending edits against a freshly-fetched record rather than the copy
 * loaded when the page rendered, so the user reviews what will actually
 * change. A row is `drifted` when the live value moved underneath the edit.
 */
export function buildReviewRows(freshRecord, loadedRecord, {
  pendingChanges = {},
  notesChanged = false,
  notes = '',
} = {}) {
  const fresh = parseQCRecord(freshRecord);
  const loaded = parseQCRecord(loadedRecord);
  const liveByName = new Map(fresh.metrics.map(metric => [metric.name, metric]));
  const loadedByName = new Map(loaded.metrics.map(metric => [metric.name, metric]));

  const rows = Object.entries(pendingChanges).map(([name, change]) => {
    const live = liveByName.get(name);
    if (!live) return { name, missing: true, drifted: true };
    const was = loadedByName.get(name);
    const row = { name, missing: false };
    if (Object.prototype.hasOwnProperty.call(change, 'value')) {
      row.currentValue = valueText(live.value);
      row.nextValue = valueText(change.value);
      row.valueDrifted = was !== undefined && !sameValue(live.value, was.value);
    }
    if (Object.prototype.hasOwnProperty.call(change, 'status')) {
      row.currentStatus = getMetricStatus(live);
      row.nextStatus = change.status;
      row.statusDrifted = was !== undefined && getMetricStatus(live) !== getMetricStatus(was);
    }
    row.drifted = Boolean(row.valueDrifted || row.statusDrifted);
    return row;
  });

  if (notesChanged) {
    rows.push({
      name: 'notes',
      isNotes: true,
      currentValue: fresh.notes ?? '',
      nextValue: notes,
      drifted: (fresh.notes ?? '') !== (loaded.notes ?? ''),
    });
  }
  return rows;
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
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState(null);
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

  /** Pull the live record and diff against it, so review reflects real state. */
  const handleReview = async () => {
    if (!changeCount || Object.values(fieldErrors).some(Boolean)) return;
    setReviewing(true);
    setMessage('');
    try {
      const records = await queryDocDb({ name: record.name }, { limit: 1 });
      if (!records.length) throw new Error(`Asset "${record.name}" is no longer in DocDB.`);
      const freshRecord = records[0];
      const [freshHash, loadedHash] = await Promise.all([
        hashQc(freshRecord.quality_control),
        hashQc(record.quality_control),
      ]);
      setReview({
        freshRecord,
        freshHash,
        changedSinceLoad: freshHash !== loadedHash,
        rows: buildReviewRows(freshRecord, record, { pendingChanges, notesChanged, notes }),
      });
      setPreview(true);
    } catch (error) {
      setMessage(`Could not load the current record to review: ${error?.message ?? error}`);
    } finally {
      setReviewing(false);
    }
  };

  const handleSubmit = async () => {
    if (!changeCount || Object.values(fieldErrors).some(Boolean) || !review) return;
    setSubmitting(true);
    setMessage('');
    try {
      const payload = buildQcSubmitPayload(review.freshRecord, {
        expectedQcHash: review.freshHash,
        pendingChanges,
        notesChanged,
        notes,
      });
      await submitQcEdit(payload);
      try {
        await onReload();
        setMessage('QC changes applied and reloaded.');
      } catch {
        setMessage('The server may have applied the change, but reload failed. Use Open QC Portal to verify.');
      }
      setPreview(false);
      setReview(null);
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
        <button
          class="qc-editor-secondary"
          onClick=${() => (preview ? setPreview(false) : handleReview())}
          disabled=${submitting || reviewing}
        >
          ${preview ? 'Back to edit' : reviewing ? 'Loading…' : `Review changes (${changeCount})`}
        </button>
      </div>
      ${message ? html`<div class="qc-editor-message">${message}</div>` : null}
      ${preview && review ? html`
        <div class="qc-editor-preview">
          <h4>Review before submit</h4>
          <p class="qc-editor-review-note">Compared against the current record in DocDB.</p>
          ${review.changedSinceLoad ? html`
            <div class="qc-editor-drift">
              This record changed since you opened the page. Rows marked changed were edited by someone else —
              check them before submitting.
            </div>
          ` : null}
          ${review.rows.length ? html`
            <table class="qc-editor-diff">
              <thead><tr><th>Field</th><th>Current</th><th>After submit</th></tr></thead>
              <tbody>
                ${review.rows.map(row => html`
                  <tr key=${row.name} class=${row.drifted ? 'qc-editor-diff-drifted' : ''}>
                    <td>
                      ${row.name}
                      ${row.drifted ? html`<span class="qc-editor-diff-flag"> changed</span>` : null}
                    </td>
                    <td>
                      ${row.missing
                        ? html`<em>no longer present</em>`
                        : html`
                          ${row.currentValue !== undefined ? html`<div>${row.currentValue}</div>` : null}
                          ${row.currentStatus !== undefined ? html`<div>status: ${row.currentStatus}</div>` : null}
                        `}
                    </td>
                    <td>
                      ${row.missing
                        ? html`<em>cannot apply</em>`
                        : html`
                          ${row.nextValue !== undefined ? html`<div>${row.nextValue}</div>` : null}
                          ${row.nextStatus !== undefined ? html`<div>status: ${row.nextStatus}</div>` : null}
                        `}
                    </td>
                  </tr>
                `)}
              </tbody>
            </table>
          ` : html`<p>No changes to submit.</p>`}
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
        <button
          class="qc-edit-btn"
          onClick=${handleReview}
          disabled=${reviewing || !changeCount || Object.values(fieldErrors).some(Boolean)}
        >
          ${reviewing ? 'Loading current record…' : `Review changes (${changeCount})`}
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
