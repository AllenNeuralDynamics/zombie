/**
 * mount.js — bridge between the vanilla page shell and the React island.
 *
 * The rest of the page is plain DOM. This module is lazy-imported the first
 * time a snapshot is ready, so React and React Flow never enter the default
 * bundle — the same arrangement `/record`'s interactive view uses.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import GraphDiagram from './GraphDiagram.jsx';

const roots = new WeakMap();

/**
 * Mount (or re-render) the graph into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} props - `{ snapshot, selectedId, onSelect, onSelectAxis }`.
 */
export function mountVerificationGraph(container, props) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(createElement(GraphDiagram, props));
}
