import { aggregateStatus, getMetricStatus } from './data.js';

function statusClass(status) {
  if (status === 'Pass') return 'pass';
  if (status === 'Fail') return 'fail';
  return 'pending';
}

function containsNode(node, target) {
  return node === target || Boolean(node.children?.some(child => containsNode(child, target)));
}

function buildNodeEl(node, onSelect, setSelected, selectedNode, nodeRows) {
  const li = document.createElement('li');

  const nodeRow = document.createElement('div');
  nodeRow.className = 'tree-node';
  if (node === selectedNode) {
    nodeRow.classList.add('selected');
    nodeRow.setAttribute('aria-current', 'true');
  }
  nodeRows.set(node, nodeRow);

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';

  const icon = document.createElement('span');
  icon.className = `tree-icon ${statusClass(aggregateStatus(node.metrics))}`;

  const labelSpan = document.createElement('span');
  const count = node.metrics.length;
  labelSpan.textContent = `${node.label} (${count})`;

  nodeRow.appendChild(toggle);
  nodeRow.appendChild(icon);
  nodeRow.appendChild(labelSpan);
  li.appendChild(nodeRow);

  if (node.children && node.children.length) {
    toggle.textContent = '▶';
    const childrenEl = document.createElement('ul');
    childrenEl.className = 'tree-children';
    if (selectedNode && node !== selectedNode && containsNode(node, selectedNode)) {
      childrenEl.classList.add('expanded');
      toggle.textContent = '▼';
    }

    for (const child of node.children) {
      childrenEl.appendChild(buildNodeEl(child, onSelect, setSelected, selectedNode, nodeRows));
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = childrenEl.classList.toggle('expanded');
      toggle.textContent = expanded ? '▼' : '▶';
    });

    nodeRow.addEventListener('click', () => {
      const expanded = childrenEl.classList.toggle('expanded');
      toggle.textContent = expanded ? '▼' : '▶';
      setSelected(node);
      onSelect(node);
    });

    li.appendChild(childrenEl);
  } else {
    toggle.textContent = ' ';
    nodeRow.addEventListener('click', () => {
      setSelected(node);
      onSelect(node);
    });
  }

  return li;
}

export function createTree(treeNodes, onSelect, { selectedNode = null } = {}) {
  const container = document.createElement('div');
  container.className = 'qc-tree';

  const nodeRows = new Map();
  const setSelected = (node) => {
    for (const [candidate, row] of nodeRows) {
      row.classList.toggle('selected', candidate === node);
      if (candidate === node) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
  };

  const ul = document.createElement('ul');
  for (const node of treeNodes) {
    ul.appendChild(buildNodeEl(node, onSelect, setSelected, selectedNode, nodeRows));
  }

  container.appendChild(ul);
  container.syncStatuses = (statusDrafts = {}) => {
    for (const [node, row] of nodeRows) {
      const statuses = node.metrics.map(metric => statusDrafts[metric.name] ?? getMetricStatus(metric));
      const status = statuses.includes('Fail')
        ? 'Fail'
        : statuses.includes('Pending') ? 'Pending' : 'Pass';
      const icon = row.querySelector('.tree-icon');
      if (icon) icon.className = `tree-icon ${statusClass(status)}`;
    }
  };
  return container;
}

/** Return the grouping key/value path identifying a node within the tree. */
export function getTreeNodePath(treeNodes, target, ancestors = []) {
  for (const node of treeNodes) {
    const path = [...ancestors, { key: node.key, value: node.value }];
    if (node === target) return path;
    if (node.children?.length) {
      const childPath = getTreeNodePath(node.children, target, path);
      if (childPath) return childPath;
    }
  }
  return null;
}

/** Encode a node path while keeping the individual path segments unambiguous. */
export function encodeTreeNodePath(path) {
  return (path ?? [])
    .map(({ key, value }) => `${encodeURIComponent(String(key))}=${encodeURIComponent(String(value))}`)
    .join('/');
}

function decodeTreeNodePath(encodedPath) {
  if (!encodedPath) return [];
  return encodedPath.split('/').map((segment) => {
    const separator = segment.indexOf('=');
    if (separator < 0) return null;
    try {
      return {
        key: decodeURIComponent(segment.slice(0, separator)),
        value: decodeURIComponent(segment.slice(separator + 1)),
      };
    } catch {
      return null;
    }
  });
}

/** Find a tree node from the path produced by encodeTreeNodePath(). */
export function findTreeNodeByPath(treeNodes, encodedPath) {
  const path = decodeTreeNodePath(encodedPath);
  if (!path.length || path.some(segment => !segment)) return null;

  let candidates = treeNodes;
  let match = null;
  for (const segment of path) {
    match = candidates.find(node => String(node.key) === segment.key && String(node.value) === segment.value);
    if (!match) return null;
    candidates = match.children ?? [];
  }
  return match;
}
