/**
 * qc-tree.test.js
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi } from 'vitest';

import { createTree } from '../qc/tree.js';

const makeMetric = (status = 'Pass') => ({
  name: 'metric',
  tags: {},
  status_history: [{ status }],
  modality: { abbreviation: 'ecephys' },
});

const makeNode = (label, metrics, children = []) => ({ label, key: 'probe', value: label, metrics, children });

describe('createTree', () => {
  it('renders a ul with correct number of top-level nodes', () => {
    const nodes = [
      makeNode('probeA', [makeMetric()]),
      makeNode('probeB', [makeMetric()]),
    ];
    const el = createTree(nodes, () => {});
    const lis = el.querySelectorAll(':scope > ul > li');
    expect(lis.length).toBe(2);
  });

  it('shows label and count in node text', () => {
    const nodes = [makeNode('probeA', [makeMetric(), makeMetric()])];
    const el = createTree(nodes, () => {});
    expect(el.textContent).toContain('probeA');
    expect(el.textContent).toContain('(2)');
  });

  it('calls onSelect when leaf node is clicked', () => {
    const onSelect = vi.fn();
    const node = makeNode('probeA', [makeMetric()], []);
    const el = createTree([node], onSelect);
    const nodeRow = el.querySelector('.tree-node');
    nodeRow.click();
    expect(onSelect).toHaveBeenCalledWith(node);
  });

  it('does not call onSelect immediately when parent node is expanded', () => {
    const onSelect = vi.fn();
    const child = makeNode('drift', [makeMetric()], []);
    const parent = makeNode('probeA', [makeMetric()], [child]);
    const el = createTree([parent], onSelect);
    const toggle = el.querySelector('.tree-toggle');
    toggle.click();
    const children = el.querySelector('.tree-children');
    expect(children.classList.contains('expanded')).toBe(true);
  });

  it('renders nested children ul', () => {
    const child = makeNode('drift', [makeMetric()], []);
    const parent = makeNode('probeA', [makeMetric()], [child]);
    const el = createTree([parent], () => {});
    const nested = el.querySelector('.tree-children');
    expect(nested).not.toBeNull();
    expect(nested.querySelectorAll('li').length).toBe(1);
  });

  it('applies pass status icon class for passing metrics', () => {
    const nodes = [makeNode('probeA', [makeMetric('Pass')])];
    const el = createTree(nodes, () => {});
    expect(el.querySelector('.tree-icon').classList.contains('pass')).toBe(true);
  });

  it('applies fail status icon class when any metric fails', () => {
    const nodes = [makeNode('probeA', [makeMetric('Pass'), makeMetric('Fail')])];
    const el = createTree(nodes, () => {});
    expect(el.querySelector('.tree-icon').classList.contains('fail')).toBe(true);
  });
});
