import { parseQCRecord, buildTreeNodes } from './data.js';
import {
  createTree,
  encodeTreeNodePath,
  findTreeNodeByPath,
  getTreeNodePath,
} from './tree.js';
import { renderMetrics, renderMetricsTable, statusDotClass, statusShadeClass } from './metrics.js';
import { mountQcEditor, readQcViewMode, writeQcViewMode } from './editor.js';
import { loginForQc } from '../lib/qc-spa-auth.js';

const QC_TREE_PARAM = 'tree';
const QC_OPEN_PARAM = 'open';

function readOpenAccordionParam(params) {
  if (!params.has(QC_OPEN_PARAM)) return null;

  const values = params.getAll(QC_OPEN_PARAM);
  if (values.length === 1 && values[0].startsWith('[')) {
    try {
      const parsed = JSON.parse(values[0]);
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter(value => typeof value === 'string'));
      }
    } catch {
      // Fall through to the repeated-parameter format for hand-edited links.
    }
  }
  return new Set(values);
}

export function readQcNavigationState(treeNodes, href = window.location.href) {
  const url = new URL(href, window.location.origin);
  const treePath = url.searchParams.get(QC_TREE_PARAM);
  const activeNode = treePath ? findTreeNodeByPath(treeNodes, treePath) : null;
  return {
    activeNode,
    // An obsolete tree path should fall back to the normal first-node/first-
    // accordion defaults instead of applying open state from another node.
    openReferences: treePath && !activeNode ? null : readOpenAccordionParam(url.searchParams),
  };
}

export function writeQcNavigationState(activeNode, treeNodes, openReferences) {
  try {
    const url = new URL(window.location.href);
    const path = activeNode ? getTreeNodePath(treeNodes, activeNode) : null;
    if (path?.length) url.searchParams.set(QC_TREE_PARAM, encodeTreeNodePath(path));
    else url.searchParams.delete(QC_TREE_PARAM);

    if (openReferences === null) url.searchParams.delete(QC_OPEN_PARAM);
    else url.searchParams.set(QC_OPEN_PARAM, JSON.stringify([...openReferences]));

    history.replaceState(history.state, '', url);
  } catch {
    // URL/history APIs can be restricted in embedded contexts.
  }
}

export function syncQcStatusShading(container, statusDrafts = {}) {
  for (const element of container.querySelectorAll('.qc-metric-card[data-qc-status-metric], .qc-metrics-table-row[data-qc-status-metric]')) {
    const status = statusDrafts[element.dataset.qcStatusMetric];
    if (!status) continue;
    element.classList.remove('qc-metric-status-fail', 'qc-metric-status-pending');
    const shade = statusShadeClass(status);
    if (shade) element.classList.add(shade);

    const metricStatus = element.querySelector('.metric-status:not(.metric-status-editor)');
    if (metricStatus) {
      const dot = metricStatus.querySelector('.status-dot');
      if (dot) dot.className = `status-dot ${statusDotClass(status)}`;
      const textNode = [...metricStatus.childNodes].find(node => node.nodeType === 3);
      if (textNode) textNode.nodeValue = status;
      else metricStatus.appendChild(document.createTextNode(status));
    }

    const tableStatus = element.querySelector('.qc-table-status');
    if (tableStatus) {
      tableStatus.className = `qc-table-status ${statusDotClass(status)}`;
      tableStatus.textContent = status;
    }

    const statusSelect = element.querySelector('.qc-inline-status');
    if (statusSelect) statusSelect.value = status;
  }
}

export function createQCView(record, rawS3Loc = '', { onReload = null } = {}) {
  const parsed = parseQCRecord(record);
  const { name, s3Bucket, s3Prefix, projectName, codeOceanId, modalities, stages, metrics, defaultGrouping, notes } = parsed;

  const root = document.createElement('div');
  let viewMode = readQcViewMode();
  let editState = { enabled: false, draftRevision: 0 };
  const treeNodes = buildTreeNodes(metrics, defaultGrouping);
  const initialNavigation = readQcNavigationState(treeNodes);
  let activeNode = initialNavigation.activeNode ?? treeNodes[0] ?? null;
  let openAccordionReferences = initialNavigation.openReferences;

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
  root.appendChild(body);
  let treeElement = null;

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

  const readRenderedAccordionReferences = (container = body) => {
    const accordions = [...container.querySelectorAll('.qc-accordion details')];
    if (!accordions.length) return null;
    return new Set(accordions.filter(details => details.open)
      .map(details => details.dataset.qcAccordionReference ?? ''));
  };

  const renderBody = () => {
    const renderedAccordionReferences = readRenderedAccordionReferences();
    if (renderedAccordionReferences !== null) openAccordionReferences = renderedAccordionReferences;
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

    const renderSelectedMetrics = (node) => {
      const selectedMetrics = node?.metrics ?? metrics;
      if (!selectedMetrics.length) {
        const empty = document.createElement('p');
        empty.className = 'qc-empty';
        empty.textContent = 'No QC data available for this asset.';
        return empty;
      }
      return renderMetrics(selectedMetrics, s3Bucket, s3Prefix, name, rawS3Loc, editState, {
        openReferences: openAccordionReferences,
        getEditState: () => editState,
        onAccordionStateChange: (references) => {
          openAccordionReferences = references;
          writeQcNavigationState(activeNode, treeNodes, openAccordionReferences);
        },
      });
    };

    const onSelect = (node) => {
      activeNode = node;
      // A newly selected tree node starts with its first accordion open.
      openAccordionReferences = null;
      contentArea.replaceChildren(renderSelectedMetrics(node));
      openAccordionReferences = readRenderedAccordionReferences(contentArea);
      writeQcNavigationState(activeNode, treeNodes, openAccordionReferences);
    };
    treeElement = createTree(treeNodes, onSelect, { selectedNode: activeNode });
    body.appendChild(treeElement);
    body.appendChild(contentArea);

    contentArea.appendChild(renderSelectedMetrics(activeNode));
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
        treeElement?.syncStatuses?.(editState.statusDrafts);
        syncEditErrors();
      }
    },
  });
  return root;
}

export function buildHeader(name, _projectName, codeOceanId, modalities, stages, {
  viewMode = 'tree',
  onViewModeChange = null,
} = {}) {
  const header = document.createElement('div');
  header.className = 'qc-header';

  const topRow = document.createElement('div');
  topRow.className = 'qc-header-top';

  const h2 = document.createElement('h2');
  const assetLink = document.createElement('a');
  assetLink.href = `/view?asset=${encodeURIComponent(name)}`;
  assetLink.textContent = name;
  h2.appendChild(assetLink);
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

  const metaLink = document.createElement('a');
  metaLink.href = `/record?name=${encodeURIComponent(name)}`;
  metaLink.target = '_blank';
  metaLink.rel = 'noopener noreferrer';
  metaLink.textContent = 'Metadata';
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
