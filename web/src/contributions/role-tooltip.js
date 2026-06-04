/**
 * role-tooltip.js — Hover tooltip for CRediT role names.
 *
 * Uses position:fixed so it escapes overflow:auto containers (e.g. the
 * horizontal-scroll table wrapper).
 */

import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { CREDIT_ROLE_DESCRIPTIONS } from './credit-helpers.js';

export function RoleTip({ name }) {
  const [pos, setPos] = useState(null);
  const info = CREDIT_ROLE_DESCRIPTIONS[name];

  if (!info) return html`<span>${name}</span>`;

  function show(e) {
    const r = e.currentTarget.getBoundingClientRect();
    // Keep popup within viewport horizontally
    const x = Math.min(r.left, window.innerWidth - 328);
    setPos({ x, y: r.bottom + 6 });
  }

  function hide() { setPos(null); }

  return html`
    <span class="cv-role-tip" onMouseEnter=${show} onMouseLeave=${hide}>
      ${name}
      <span class="cv-role-tip-icon" aria-hidden="true">ⓘ</span>
      ${pos && html`
        <span class="cv-role-tip-popup" role="tooltip"
              style=${{ left: pos.x + 'px', top: pos.y + 'px' }}>
          <strong class="cv-role-tip-title">${name}</strong>
          <em class="cv-role-tip-def">${info.definition}</em>
          <ul class="cv-role-tip-examples">
            ${info.examples.map((ex, i) => html`<li key=${i}>${ex}</li>`)}
          </ul>
        </span>
      `}
    </span>
  `;
}
