import { parseQCRecord, buildTreeNodes } from './data.js';
import { createTree } from './tree.js';
import { renderMetrics, renderMetricsTable, statusShadeClass } from './metrics.js';
import { mountQcEditor } from './editor.js';
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

  const header = buildHeader(name, projectName, codeOceanId, modalities, stages);
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

  let editState = { enabled: false, viewMode: 'tree' };
  let activeNode = null;

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

  const renderBody = () => {
    body.replaceChildren();
    if (editState.viewMode === 'table') {
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
  };

  renderBody();
  mountQcEditor(editor, record, {
    onReload,
    onEditStateChange: (nextState) => {
      const layoutChanged = nextState.enabled !== editState.enabled ||
        nextState.viewMode !== editState.viewMode ||
        nextState.allowEditingValues !== editState.allowEditingValues;
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

export function buildHeader(name, projectName, codeOceanId, modalities, stages) {
  const header = document.createElement('div');
  header.className = 'qc-header';

  const topRow = document.createElement('div');
  topRow.className = 'qc-header-top';

  const h2 = document.createElement('h2');
  h2.textContent = name;
  topRow.appendChild(h2);

  const actions = document.createElement('div');
  actions.className = 'qc-header-actions';

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
