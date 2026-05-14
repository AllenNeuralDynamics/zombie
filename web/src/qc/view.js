import { parseQCRecord, buildTreeNodes } from './data.js';
import { createTree } from './tree.js';
import { renderMetrics } from './metrics.js';

export function createQCView(record) {
  const parsed = parseQCRecord(record);
  const { name, s3Bucket, s3Prefix, projectName, codeOceanId, modalities, stages, metrics, defaultGrouping } = parsed;

  const root = document.createElement('div');

  const header = buildHeader(name, projectName, codeOceanId, modalities, stages);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'qc-container';

  const contentArea = document.createElement('div');
  contentArea.className = 'qc-content';

  const treeNodes = buildTreeNodes(metrics, defaultGrouping);

  const onSelect = (node) => {
    contentArea.innerHTML = '';
    contentArea.appendChild(renderMetrics(node.metrics, s3Bucket, s3Prefix, name));
  };

  const tree = createTree(treeNodes, onSelect);
  body.appendChild(tree);
  body.appendChild(contentArea);

  if (metrics.length) {
    contentArea.appendChild(renderMetrics(metrics, s3Bucket, s3Prefix, name));
  } else {
    const empty = document.createElement('p');
    empty.className = 'qc-empty';
    empty.textContent = 'No QC data available for this asset.';
    contentArea.appendChild(empty);
  }

  root.appendChild(body);
  return root;
}

function buildHeader(name, projectName, codeOceanId, modalities, stages) {
  const header = document.createElement('div');
  header.className = 'qc-header';

  const topRow = document.createElement('div');
  topRow.className = 'qc-header-top';

  const h2 = document.createElement('h2');
  h2.textContent = name;
  topRow.appendChild(h2);

  const editBtn = document.createElement('button');
  editBtn.className = 'qc-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    window.open(`https://qc.allenneuraldynamics.org/view?name=${encodeURIComponent(name)}`, '_blank');
  });
  topRow.appendChild(editBtn);
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
    a.href = `https://qc.allenneuraldynamics.org/portal?projects=['${encodeURIComponent(projectName)}']`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Project page';
    links.appendChild(a);
  }

  const metaLink = document.createElement('a');
  metaLink.href = `https://metadata-portal.allenneuraldynamics.org/view?name=${encodeURIComponent(name)}`;
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
