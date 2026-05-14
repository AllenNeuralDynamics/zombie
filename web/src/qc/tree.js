import { aggregateStatus } from './data.js';

function statusClass(status) {
  if (status === 'Pass') return 'pass';
  if (status === 'Fail') return 'fail';
  return 'pending';
}

function buildNodeEl(node, onSelect) {
  const li = document.createElement('li');

  const nodeRow = document.createElement('div');
  nodeRow.className = 'tree-node';

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

    for (const child of node.children) {
      childrenEl.appendChild(buildNodeEl(child, onSelect));
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = childrenEl.classList.toggle('expanded');
      toggle.textContent = expanded ? '▼' : '▶';
    });

    nodeRow.addEventListener('click', () => {
      const expanded = childrenEl.classList.toggle('expanded');
      toggle.textContent = expanded ? '▼' : '▶';
      onSelect(node);
    });

    li.appendChild(childrenEl);
  } else {
    toggle.textContent = ' ';
    nodeRow.addEventListener('click', () => onSelect(node));
  }

  return li;
}

export function createTree(treeNodes, onSelect) {
  const container = document.createElement('div');
  container.className = 'qc-tree';

  const ul = document.createElement('ul');
  for (const node of treeNodes) {
    ul.appendChild(buildNodeEl(node, onSelect));
  }

  container.appendChild(ul);
  return container;
}
