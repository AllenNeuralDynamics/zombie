import { html } from 'htm/preact';
import { render } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { QC_SPA_EDITOR_ENABLED } from '../constants.js';
import { queryDocDb } from '../lib/docdb.js';
import { getQcAccount } from '../lib/qc-spa-auth.js';
import { submitQcEdit } from './api.js';
import { hashQc } from './canonical.js';
import { getMetricStatus, parseQCRecord } from './data.js';
import {
  autoStatusForValue,
  isEditableMetric,
  parseDraft,
  sameValue,
  valueText,
} from './edit-model.js';

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
  if (error.status >= 500) return 'QC editing is temporarily unavailable. Use Open Legacy QC Portal to edit.';
  return error.message || 'QC submission failed.';
}

function isOpaqueIdentity(value) {
  return typeof value !== 'string' || /^[A-Za-z0-9_-]{32,}$/.test(value.trim());
}

function firstHumanIdentity(...values) {
  return values.find(value => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && !isOpaqueIdentity(text);
  })?.trim() || '';
}

export const QC_VIEW_MODE_STORAGE_KEY = 'zombie.qc.viewMode';
const QC_VIEW_MODES = new Set(['tree', 'table']);
export const QC_PENDING_CHANGES_STORAGE_PREFIX = 'zombie.qc.pendingChanges:';

function browserStorage() {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage; } catch { return null; }
}

export function readQcViewMode(storage = browserStorage()) {
  try {
    const value = storage?.getItem(QC_VIEW_MODE_STORAGE_KEY);
    return QC_VIEW_MODES.has(value) ? value : 'tree';
  } catch {
    return 'tree';
  }
}

export function writeQcViewMode(viewMode, storage = browserStorage()) {
  if (!QC_VIEW_MODES.has(viewMode)) return;
  try { storage?.setItem(QC_VIEW_MODE_STORAGE_KEY, viewMode); } catch { /* storage may be unavailable */ }
}

export function qcPendingChangesStorageKey(assetName) {
  return `${QC_PENDING_CHANGES_STORAGE_PREFIX}${encodeURIComponent(String(assetName ?? ''))}`;
}

export function readQcPendingChanges(assetName, storage = browserStorage()) {
  try {
    const raw = storage?.getItem(qcPendingChangesStorageKey(assetName));
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeQcPendingChanges(assetName, drafts, storage = browserStorage()) {
  try {
    storage?.setItem(qcPendingChangesStorageKey(assetName), JSON.stringify(drafts));
  } catch { /* storage may be unavailable or full */ }
}

export function clearQcPendingChanges(assetName, storage = browserStorage()) {
  try { storage?.removeItem(qcPendingChangesStorageKey(assetName)); } catch { /* storage may be unavailable */ }
}

export function accountDisplayName(account) {
  const claims = account?.idTokenClaims ?? {};
  const composedName = [claims.given_name, claims.family_name].filter(Boolean).join(' ');
  return firstHumanIdentity(
    claims.name,
    claims.display_name,
    composedName,
    account?.name,
    claims.preferred_username,
    claims.email,
    claims.upn,
    account?.username,
  ) || 'AIND account';
}

function restoreDrafts(defaults, saved, isValid) {
  const restored = { ...defaults };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return restored;
  for (const name of Object.keys(defaults)) {
    if (isValid(saved[name])) restored[name] = saved[name];
  }
  return restored;
}

function draftValueChanged(metric, draft) {
  try { return !sameValue(parseDraft(draft, metric.value), metric.value); } catch { return true; }
}

export function QcEditor({ record, onReload, onEditStateChange }) {
  if (!QC_SPA_EDITOR_ENABLED) return null;
  const parsed = useMemo(() => parseQCRecord(record), [record]);
  const editableMetrics = useMemo(() => parsed.metrics.filter(isEditableMetric), [parsed]);
  const defaultValueDrafts = useMemo(() => Object.fromEntries(
    editableMetrics.map(metric => [metric.name, valueText(metric.value)]),
  ), [editableMetrics]);
  const defaultStatusDrafts = useMemo(() => Object.fromEntries(
    editableMetrics.map(metric => [metric.name, getMetricStatus(metric)]),
  ), [editableMetrics]);
  const savedDrafts = useMemo(() => readQcPendingChanges(record.name), [record.name]);
  const [account, setAccount] = useState(null);
  const [valueDrafts, setValueDrafts] = useState(() => restoreDrafts(
    defaultValueDrafts,
    savedDrafts?.valueDrafts,
    value => typeof value === 'string',
  ));
  const [statusDrafts, setStatusDrafts] = useState(() => restoreDrafts(
    defaultStatusDrafts,
    savedDrafts?.statusDrafts,
    value => value === 'Pending' || value === 'Pass' || value === 'Fail',
  ));
  const [fieldErrors, setFieldErrors] = useState({});
  const [notes, setNotes] = useState(() => (
    typeof savedDrafts?.notes === 'string' ? savedDrafts.notes : parsed.notes
  ));
  const [preview, setPreview] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [allowEditingValues, setAllowEditingValues] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftRevision, setDraftRevision] = useState(0);

  useEffect(() => {
    let alive = true;
    getQcAccount().then(value => {
      if (alive) setAccount(value);
    }).catch(() => {
      if (alive) setAccount(null);
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
  const hasPendingDrafts = editableMetrics.some(metric =>
    draftValueChanged(metric, valueDrafts[metric.name]) ||
    statusDrafts[metric.name] !== getMetricStatus(metric)
  ) || notesChanged;

  useEffect(() => {
    if (!hasPendingDrafts) {
      clearQcPendingChanges(record.name);
      return;
    }
    writeQcPendingChanges(record.name, { valueDrafts, statusDrafts, notes });
  }, [record.name, editableMetrics, valueDrafts, statusDrafts, notes, parsed.notes]);

  const clearPendingChanges = () => {
    clearQcPendingChanges(record.name);
    setValueDrafts(defaultValueDrafts);
    setStatusDrafts(defaultStatusDrafts);
    setFieldErrors({});
    setNotes(parsed.notes);
    setMessage('');
    setDraftRevision(revision => revision + 1);
  };

  const handleValue = (metric, value) => {
    setValueDrafts(previous => ({ ...previous, [metric.name]: value }));
    try {
      const parsedValue = parseDraft(value, metric.value);
      setFieldErrors(previous => ({ ...previous, [metric.name]: undefined }));
      const autoStatus = autoStatusForValue(parsedValue);
      if (autoStatus) setStatusDrafts(previous => ({ ...previous, [metric.name]: autoStatus }));
    } catch (error) {
      setFieldErrors(previous => ({ ...previous, [metric.name]: error.message }));
    }
  };

  useEffect(() => {
    onEditStateChange?.({
      enabled: Boolean(account),
      editableMetricNames: new Set(editableMetrics.map(metric => metric.name)),
      valueDrafts,
      statusDrafts,
      fieldErrors,
      allowEditingValues,
      draftRevision,
      onValue: (name, value) => {
        const metric = editableMetrics.find(candidate => candidate.name === name);
        if (metric) handleValue(metric, value);
      },
      onStatus: (name, value) => setStatusDrafts(previous => ({ ...previous, [name]: value })),
    });
  }, [account, editableMetrics, valueDrafts, statusDrafts, fieldErrors, allowEditingValues, draftRevision]);

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
      clearQcPendingChanges(record.name);
      try {
        await onReload();
        setMessage('QC changes applied and reloaded.');
      } catch {
        setMessage('The server may have applied the change, but reload failed. Use Open Legacy QC Portal to verify.');
      }
      setPreview(false);
      setReview(null);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (!account) return null;

  return html`
    <section class="qc-editor">
      <div class="qc-editor-heading">
        <div class="qc-editor-title">
          <div class="qc-editor-title-row">
            <h3>Edit QC</h3>
            ${!preview ? html`
              <button
                class="qc-settings-btn icon-btn"
                aria-label="QC editing settings"
                onClick=${() => setSettingsOpen(true)}
              >
                <img src="/icons/gear.svg" alt="Settings" />
              </button>
            ` : null}
          </div>
          <small>Signed in as ${accountDisplayName(account)}</small>
        </div>
        <div class="qc-editor-actions">
          <button
            class="qc-editor-secondary"
            onClick=${() => (preview ? setPreview(false) : handleReview())}
            disabled=${submitting || reviewing}
          >
            ${preview ? 'Back to edit' : reviewing ? 'Loading…' : `Review changes (${changeCount})`}
          </button>
        </div>
      </div>
      ${settingsOpen ? html`
        <div class="qc-settings-overlay" role="dialog" aria-modal="true" aria-label="QC settings">
          <div class="qc-settings-modal">
            <h4>QC settings</h4>
            <label class="qc-settings-option">
              <input
                type="checkbox"
                checked=${allowEditingValues}
                onChange=${event => setAllowEditingValues(event.currentTarget.checked)}
              />
              Allow editing metrics with values
            </label>
            <div class="qc-settings-actions">
              <button
                class="qc-editor-secondary"
                onClick=${clearPendingChanges}
                disabled=${!hasPendingDrafts || submitting}
              >
                Clear pending changes
              </button>
              <button class="qc-editor-secondary" onClick=${() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      ` : null}
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
        <label class="qc-editor-label">Notes<textarea rows="3" value=${notes} onInput=${event => setNotes(event.currentTarget.value)} /></label>
      `}
    </section>
  `;
}

export function mountQcEditor(container, record, options = {}) {
  if (!QC_SPA_EDITOR_ENABLED) return () => {};
  render(html`
    <${QcEditor}
      record=${record}
      onReload=${options.onReload || (() => Promise.resolve())}
      onEditStateChange=${options.onEditStateChange}
    />
  `, container);
  return () => render(null, container);
}
