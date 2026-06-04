/**
 * role-tooltip.js — Hover tooltip for CRediT role names.
 *
 * Renders the popup via createPortal into document.body so it escapes
 * both overflow:auto containers and inherited styles (bold from <th> etc).
 */

import { html } from 'htm/preact';
import { useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { CREDIT_ROLE_DESCRIPTIONS } from './credit-helpers.js';

export function RoleTip({ name }) {
  const [pos, setPos] = useState(null);
  const info = CREDIT_ROLE_DESCRIPTIONS[name];

  if (!info) return html`<span>${name}</span>`;

  function show(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const TIP_W = 300;
    const GAP = 8;
    const x = Math.min(Math.max(GAP, r.left), window.innerWidth - TIP_W - GAP);
    setPos({ x, y: r.bottom + 6 });
  }

  function hide() { setPos(null); }

  const popup = pos && createPortal(
    html`
      <div class="cv-role-tip-popup" role="tooltip"
           style=${{ left: pos.x + 'px', top: pos.y + 'px' }}>
        <strong class="cv-role-tip-title">${name}</strong>
        <em class="cv-role-tip-def">${info.definition}</em>
        <ul class="cv-role-tip-examples">
          ${info.examples.map((ex, i) => html`<li key=${i}>${ex}</li>`)}
        </ul>
      </div>
    `,
    document.body,
  );

  return html`
    <span class="cv-role-tip" onMouseEnter=${show} onMouseLeave=${hide}>
      ${name}
      <span class="cv-role-tip-icon" aria-hidden="true">ⓘ</span>
      ${popup}
    </span>
  `;
}
