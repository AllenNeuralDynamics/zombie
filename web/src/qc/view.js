import { parseQCRecord, buildTreeNodes } from './data.js';
import { createTree } from './tree.js';
import { renderMetrics, renderMetricsTable, statusShadeClass } from './metrics.js';
import { mountQcEditor, readQcViewMode, writeQcViewMode } from './editor.js';
import { loginForQc } from '../lib/qc-spa-auth.js';

export function syncQcStatusShading(container, statusDrafts = {}) {
  for (const element of container.querySelectorAll('.qc-metric-card[data-qc-status-metric], .qc-metrics-table-row[data-qc-status-metric]')) {
    const status = statusDrafts[element.dataset.qcStatusMetric];
    if (!status) continue;
    element.classList.remove('qc-metric-status-fail', 'qc-metric-status-pending');
    const shade = statusShadeClass(status);
    if (shade) element.classList.add(shade);
  }
}

export function createQCView(record, rawS3Loc = '', { onReload = null } = {}) {
  const parsed = parseQCRecord(record);
  const { name, s3Bucket, s3Prefix, projectName, codeOceanId, modalities, stages, metrics, defaultGrouping, notes } = parsed;

  const root = document.createElement('div');
  let viewMode = readQcViewMode();
  let editState = { enabled: false, draftRevision: 0 };
  let activeNode = null;

  const header = buildHeader(name, projectName, codeOceanId, modalities, stages, {
    viewMode,
    onViewModeChange: (nextViewMode) => {
      if (nextViewMode === viewMode) return;
      viewMode = nextViewMode;
      writeQcViewMode(viewMode);
      renderBody();
    },
  });
  root.appendChild(header);

  const editor = document.createElement('div');
  editor.className = 'qc-editor-host';
  root.appendChild(editor);

  if (notes) {
    const notesEl = document.createElement('div');
    notesEl.className = 'qc-notes';
    notesEl.title = 'Use edit mode to edit notes';
    const label = document.createElement('span');
    label.className = 'qc-notes-label';
    label.textContent = 'Notes: ';
    notesEl.appendChild(label);
    notesEl.appendChild(document.createTextNode(notes));
    root.appendChild(notesEl);
  }

  const body = document.createElement('div');
  body.className = 'qc-container';
  const treeNodes = buildTreeNodes(metrics, defaultGrouping);
  root.appendChild(body);

  const syncEditErrors = () => {
    for (const wrapper of body.querySelectorAll('[data-qc-metric]')) {
      const error = editState.fieldErrors?.[wrapper.dataset.qcMetric];
      const current = wrapper.querySelector('.qc-inline-field-error');
      if (error && !current) {
        const errorEl = document.createElement('div');
        errorEl.className = 'qc-inline-field-error';
        errorEl.textContent = error;
        wrapper.appendChild(errorEl);
      } else if (!error && current) {
        current.remove();
      } else if (error && current) {
        current.textContent = error;
      }
    }
  };

  const accordionState = () => ({
    hadAccordion: Boolean(body.querySelector('.qc-accordion')),
    openLabels: new Set([...body.querySelectorAll('.qc-accordion details')]
      .filter(details => details.open)
      .map(details => details.querySelector('summary')?.textContent ?? '')),
  });

  const restoreAccordionState = (state) => {
    if (!state.hadAccordion) return;
    for (const details of body.querySelectorAll('.qc-accordion details')) {
      details.open = state.openLabels.has(details.querySelector('summary')?.textContent ?? '');
    }
  };

  const renderBody = () => {
    const previousAccordionState = accordionState();
    body.replaceChildren();
    if (viewMode === 'table') {
      body.classList.add('qc-container-table');
      const content = document.createElement('div');
      content.className = 'qc-table-content';
      if (metrics.length) {
        content.appendChild(renderMetricsTable(metrics, s3Bucket, s3Prefix, name, rawS3Loc, editState, treeNodes));
      } else {
        const empty = document.createElement('p');
        empty.className = 'qc-empty';
        empty.textContent = 'No QC data available for this asset.';
        content.appendChild(empty);
      }
      body.appendChild(content);
      return;
    }

    body.classList.remove('qc-container-table');
    const contentArea = document.createElement('div');
    contentArea.className = 'qc-content';
    const onSelect = (node) => {
      activeNode = node;
      contentArea.replaceChildren(renderMetrics(node.metrics, s3Bucket, s3Prefix, name, rawS3Loc, editState));
    };
    const tree = createTree(treeNodes, onSelect);
    body.appendChild(tree);
    body.appendChild(contentArea);

    const selectedMetrics = activeNode?.metrics ?? metrics;
    if (selectedMetrics.length) {
      contentArea.appendChild(renderMetrics(selectedMetrics, s3Bucket, s3Prefix, name, rawS3Loc, editState));
    } else {
      const empty = document.createElement('p');
      empty.className = 'qc-empty';
      empty.textContent = 'No QC data available for this asset.';
      contentArea.appendChild(empty);
    }
    restoreAccordionState(previousAccordionState);
  };

  renderBody();
  mountQcEditor(editor, record, {
    onReload,
    onEditStateChange: (nextState) => {
      const layoutChanged = nextState.enabled !== editState.enabled ||
        nextState.allowEditingValues !== editState.allowEditingValues ||
        nextState.draftRevision !== editState.draftRevision;
      editState = nextState;
      if (layoutChanged) renderBody();
      else {
        syncQcStatusShading(body, editState.statusDrafts);
        syncEditErrors();
      }
    },
  });
  return root;
}

export function buildHeader(name, projectName, codeOceanId, modalities, stages, {
  viewMode = 'tree',
  onViewModeChange = null,
} = {}) {
  const header = document.createElement('div');
  header.className = 'qc-header';

  const topRow = document.createElement('div');
  topRow.className = 'qc-header-top';

  const h2 = document.createElement('h2');
  h2.textContent = name;
  topRow.appendChild(h2);

  const actions = document.createElement('div');
  actions.className = 'qc-header-actions';

  const viewToggle = document.createElement('div');
  viewToggle.className = 'qc-view-toggle';
  viewToggle.setAttribute('role', 'group');
  viewToggle.setAttribute('aria-label', 'Metric layout');
  const viewButtons = [];
  for (const mode of ['tree', 'table']) {
    const button = document.createElement('button');
    button.className = mode === viewMode ? 'active' : '';
    button.textContent = mode === 'tree' ? 'Tree view' : 'Table view';
    button.addEventListener('click', () => {
      viewButtons.forEach(candidate => candidate.classList.toggle('active', candidate === button));
      onViewModeChange?.(mode);
    });
    viewButtons.push(button);
    viewToggle.appendChild(button);
  }
  actions.appendChild(viewToggle);

  const editBtn = document.createElement('button');
  editBtn.className = 'qc-edit-btn';
  editBtn.textContent = 'Open Legacy QC Portal';
  editBtn.addEventListener('click', () => {
    window.open(`https://qc.allenneuraldynamics.org/view?name=${encodeURIComponent(name)}`, '_blank');
  });
  actions.appendChild(editBtn);

  const loginBtn = document.createElement('button');
  loginBtn.className = 'qc-login-btn';
  loginBtn.textContent = 'Login';
  loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    try {
      await loginForQc();
    } catch (error) {
      console.error('QC login failed', error);
      loginBtn.disabled = false;
    }
  });
  actions.appendChild(loginBtn);
  topRow.appendChild(actions);
  header.appendChild(topRow);

  if (modalities.length || stages.length) {
    const meta = document.createElement('div');
    meta.className = 'qc-header-meta';
    const parts = [];
    if (modalities.length) parts.push(`Modalities: ${modalities.join(', ')}`);
    if (stages.length) parts.push(`Stages: ${stages.join(', ')}`);
    meta.textContent = parts.join(' · ');
    header.appendChild(meta);
  }

  const links = document.createElement('div');
  links.className = 'qc-header-links';

  if (projectName) {
    const a = document.createElement('a');
    a.href = `/view?project=${encodeURIComponent(projectName)}`;
    a.textContent = 'Project page';
    links.appendChild(a);
  }

  const metaLink = document.createElement('a');
  metaLink.href = `/record?name=${encodeURIComponent(name)}`;
  metaLink.target = '_blank';
  metaLink.rel = 'noopener noreferrer';
  metaLink.textContent = 'Metadata viewer';
  links.appendChild(metaLink);

  if (codeOceanId) {
    const coLink = document.createElement('a');
    coLink.href = `https://codeocean.allenneuraldynamics.org/data_assets/${codeOceanId}`;
    coLink.target = '_blank';
    coLink.rel = 'noopener noreferrer';
    coLink.textContent = 'Code Ocean';
    links.appendChild(coLink);
  }

  header.appendChild(links);
  return header;
}
