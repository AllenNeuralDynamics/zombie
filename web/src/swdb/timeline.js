/**
 * swdb/timeline.js — history timeline for one SWDB set.
 *
 * A set spans ~18 months across a dozen subjects, one session each, so neither of
 * the existing timelines fits: `lib/behavior-timeline.js` is a fixed 14-day grid,
 * and `subject/timeline.js` shows the many events of a single subject. This is the
 * complementary view — subjects on y, acquisition date on x, one dot per asset —
 * built with Observable Plot rather than hand-rolled SVG, per the project's
 * plotting policy.
 *
 * Dot area encodes trial count so a short session reads as smaller, and the
 * selected asset is ringed. Selection is exposed imperatively
 * (`element.selectAsset(name)`) so the set page can drive it from the URL as well
 * as from clicks.
 */

import * as Plot from '@observablehq/plot';

const DOT_COLOR = '#2563eb';

/**
 * Build the set timeline.
 *
 * @param {object[]} rows - Session-catalog rows for one set.
 * @param {object} [opts]
 * @param {(assetName: string) => void} [opts.onSelect]
 * @returns {HTMLElement} Wrapper exposing `selectAsset(assetName)`.
 */
export function createSetTimeline(rows, { onSelect = null } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'swdb-timeline';

  const points = rows
    .map((r) => ({
      asset: r.asset_name,
      subject: String(r.subject_id),
      date: r.session_date ? new Date(`${r.session_date}T00:00:00Z`) : null,
      trials: Number(r.n_trials) || 0,
      units: Number(r.n_units) || 0,
      hours: (Number(r.session_duration_s) || 0) / 3600,
    }))
    .filter((p) => p.date instanceof Date && !Number.isNaN(p.date.valueOf()));

  if (points.length === 0) {
    wrapper.innerHTML = '<div class="swdb-panel-status">No dated sessions in this set.</div>';
    wrapper.selectAsset = () => {};
    return wrapper;
  }

  // Subjects ordered by their session date so the timeline reads as a diagonal
  // progression rather than an arbitrary numeric shuffle.
  const order = [...points].sort((a, b) => a.date - b.date).map((p) => p.subject);
  const subjects = [...new Set(order)];

  let selected = null;
  const plotHolder = document.createElement('div');
  wrapper.appendChild(plotHolder);

  function render() {
    const figure = Plot.plot({
      height: Math.max(160, subjects.length * 26 + 60),
      marginLeft: 70,
      marginBottom: 36,
      marginRight: 20,
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'acquisition date', grid: true },
      y: { label: 'subject', domain: subjects, grid: true },
      r: { range: [3, 9] },
      marks: [
        Plot.dot(points, {
          x: 'date',
          y: 'subject',
          r: 'trials',
          fill: DOT_COLOR,
          fillOpacity: 0.75,
          stroke: DOT_COLOR,
          title: (d) =>
            `${d.asset}\nsubject ${d.subject} · ${d.date.toISOString().slice(0, 10)}\n`
            + `${d.trials} trials · ${d.units} units · ${d.hours.toFixed(1)} h`,
        }),
        // Selection ring, drawn only for the active asset.
        Plot.dot(
          points.filter((p) => p.asset === selected),
          { x: 'date', y: 'subject', r: 12, stroke: '#111827', strokeWidth: 2, fill: 'none' },
        ),
      ],
    });

    // Plot doesn't do click handling, so hit-test the nearest point in pixel space.
    figure.addEventListener('click', (ev) => {
      const nearest = _nearestPoint(figure, points, ev);
      if (nearest) {
        selectAsset(nearest.asset);
        onSelect?.(nearest.asset);
      }
    });
    figure.style.cursor = 'pointer';

    plotHolder.replaceChildren(figure);
  }

  function selectAsset(assetName) {
    if (selected === assetName) return;
    selected = assetName;
    render();
  }

  render();
  wrapper.selectAsset = selectAsset;
  return wrapper;
}

/**
 * Find the datum nearest a click, using the figure's own scales.
 *
 * Plot exposes `figure.scale(name)` with the applied domain/range, which is what
 * makes this possible without re-deriving the layout.
 *
 * @param {SVGElement|HTMLElement} figure
 * @param {object[]} points
 * @param {MouseEvent} ev
 * @returns {object|null}
 */
export function _nearestPoint(figure, points, ev) {
  const svg = figure.tagName === 'svg' ? figure : figure.querySelector('svg');
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;

  const xScale = figure.scale('x');
  const yScale = figure.scale('y');
  if (!xScale?.apply || !yScale?.apply) return null;

  let best = null;
  let bestDist = Infinity;
  for (const p of points) {
    const dx = xScale.apply(p.date) - px;
    const dy = yScale.apply(p.subject) - py;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  // Only accept clicks reasonably close to a dot.
  return bestDist <= 30 * 30 ? best : null;
}
