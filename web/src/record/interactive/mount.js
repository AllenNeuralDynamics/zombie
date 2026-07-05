/**
 * mount.js — Bridge between the vanilla record page and the React island.
 *
 * The rest of /record is plain DOM; this is lazy-imported only when the user
 * switches to the interactive view, so React + React Flow never load for the
 * default JSON view.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import RecordDiagram from './RecordDiagram.jsx';

const roots = new WeakMap();

/** Mount (or re-render) the interactive record diagram into `container`. */
export function mountRecordDiagram(container, record) {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(createElement(RecordDiagram, { record }));
}
