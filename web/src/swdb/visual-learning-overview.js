/**
 * visual-learning-overview.js — training-stage progression for the Visual
 * Learning SWDB dataset.
 *
 * The reference overview is a horizontal run of colored session blocks for
 * each subject. It is rendered with ordinary HTML grid cells so the chart stays
 * responsive, linkable, and usable without an SVG chart renderer.
 */

import { loadVisualLearningProgression } from './data.js';

const STAGE_GROUPS = [
  {
    key: 'static-gratings',
    label: 'Static gratings',
    color: '#55ad6d',
    matches: [/^TRAINING_[01](?:\b|_)/i],
  },
  {
    key: 'flashed-gratings',
    label: 'Flashed gratings',
    color: '#f04d3d',
    matches: [/^TRAINING_2(?:\b|_)/i, /^TRAINING_[01].*grating/i],
  },
  {
    key: 'flashed-images',
    label: 'Flashed images',
    color: '#f58a72',
    matches: [/^TRAINING_[345](?:\b|_)/i],
  },
  {
    key: 'familiar-images',
    label: 'Familiar images + omissions',
    color: '#f6ac8f',
    matches: [/^OPHYS_1(?:\b|_)/i],
  },
  {
    key: 'novel-images',
    label: 'Novel images + omissions',
    color: '#4d9ac3',
    matches: [/^OPHYS_4(?:\b|_)/i],
  },
  {
    key: 'novel-extinction',
    label: 'Novel images · extinction',
    color: '#93bed5',
    matches: [/^OPHYS_6(?:\b|_)/i],
  },
  {
    key: 'drifting-gratings',
    label: 'Drifting gratings',
    color: '#858589',
    matches: [/^STAGE_0(?:\b|_)/i],
  },
  {
    key: 'natural-movies',
    label: 'Natural movies',
    color: '#5f5f65',
    matches: [/^STAGE_1(?:\b|_)/i],
  },
];

const UNKNOWN_STAGE = {
  key: 'unclassified',
  label: 'Stage unavailable',
  color: '#b4b4b8',
};

/**
 * Resolve a raw session type to the display group used by the overview.
 *
 * @param {string|null|undefined} sessionType
 * @returns {{key: string, label: string, color: string}}
 */
export function visualLearningStage(sessionType) {
  const value = String(sessionType ?? '').trim();
  return STAGE_GROUPS.find((group) => group.matches.some((pattern) => pattern.test(value)))
    ?? UNKNOWN_STAGE;
}

/**
 * Group sessions by subject and sort each subject chronologically.
 *
 * @param {object[]} rows
 * @returns {{subjectId: string, sessions: object[]}[]}
 */
export function buildVisualLearningProgressionRows(rows) {
  const bySubject = new Map();
  for (const row of rows ?? []) {
    const subjectId = row.subject_id == null || row.subject_id === ''
      ? 'Unknown subject'
      : String(row.subject_id);
    const session = {
      ...row,
      subjectId,
      date: normaliseDate(row.session_date),
      stage: visualLearningStage(row.session_type),
    };
    if (!bySubject.has(subjectId)) bySubject.set(subjectId, []);
    bySubject.get(subjectId).push(session);
  }

  return [...bySubject.entries()]
    .map(([subjectId, sessions]) => ({
      subjectId,
      sessions: sessions.sort(compareSessions),
    }))
    .sort((a, b) => (
      b.sessions.length - a.sessions.length || a.subjectId.localeCompare(b.subjectId, undefined, { numeric: true })
    ));
}

function compareSessions(a, b) {
  return String(a.date ?? '').localeCompare(String(b.date ?? ''))
    || String(a.asset_name ?? '').localeCompare(String(b.asset_name ?? ''));
}

function normaliseDate(value) {
  if (value == null || value === '') return null;
  const match = String(value).match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : String(value);
}

/**
 * Build the Visual Learning training-stage overview.
 *
 * @param {object} coord
 * @param {{ onSelect?: function }} [options]
 * @returns {{element: HTMLElement, load: function, dispose: function}}
 */
export function createVisualLearningOverview(coord, { onSelect = null } = {}) {
  const section = document.createElement('section');
  section.className = 'swdb-visual-learning-overview';

  const heading = document.createElement('div');
  heading.className = 'swdb-visual-learning-heading';
  const title = document.createElement('h2');
  title.textContent = 'Training-stage progression';
  heading.appendChild(title);
  section.appendChild(heading);

  const legend = document.createElement('div');
  legend.className = 'swdb-visual-learning-legend';
  section.appendChild(legend);

  const mount = document.createElement('div');
  mount.className = 'swdb-visual-learning-mount';
  mount.innerHTML = '<div class="swdb-panel-status">Loading training stages…</div>';
  section.appendChild(mount);

  let controller = null;

  function render(rows) {
    const subjects = buildVisualLearningProgressionRows(rows);
    if (subjects.length === 0) {
      mount.innerHTML = '<div class="swdb-panel-status">No Visual Learning sessions are available.</div>';
      legend.replaceChildren();
      return;
    }

    const maxSessions = Math.max(...subjects.map((subject) => subject.sessions.length));
    renderLegend(subjects);

    const chart = document.createElement('div');
    chart.className = 'swdb-visual-learning-chart-shell';
    const grid = document.createElement('div');
    grid.className = 'swdb-visual-learning-chart';
    const template = `minmax(150px, 0.28fr) repeat(${maxSessions}, minmax(8px, 1fr))`;
    grid.style.gridTemplateColumns = template;

    const axisLabel = document.createElement('div');
    axisLabel.className = 'swdb-visual-learning-axis-label';
    axisLabel.textContent = 'Subject';
    grid.appendChild(axisLabel);
    for (let index = 1; index <= maxSessions; index += 1) {
      const tick = document.createElement('div');
      tick.className = 'swdb-visual-learning-axis-tick';
      tick.textContent = index === 1 || index % 5 === 0 || index === maxSessions ? String(index) : '';
      grid.appendChild(tick);
    }

    for (const subject of subjects) {
      const subjectLabel = document.createElement('div');
      subjectLabel.className = 'swdb-visual-learning-subject';
      const subjectLink = document.createElement('a');
      subjectLink.href = `/view?subject_id=${encodeURIComponent(subject.subjectId)}`;
      subjectLink.textContent = subject.subjectId;
      subjectLabel.appendChild(subjectLink);
      const count = document.createElement('span');
      count.textContent = `n=${subject.sessions.length}`;
      subjectLabel.appendChild(count);
      grid.appendChild(subjectLabel);

      subject.sessions.forEach((session, sessionIndex) => {
        const cell = document.createElement('a');
        cell.className = 'swdb-visual-learning-cell';
        cell.href = `/view?asset=${encodeURIComponent(session.asset_name)}`;
        cell.style.backgroundColor = session.stage.color;
        cell.dataset.asset = session.asset_name;
        cell.setAttribute(
          'aria-label',
          `${subject.subjectId}, session ${sessionIndex + 1}, `
          + `${session.stage.label}, ${session.session_type ?? 'session type unavailable'}, `
          + `${session.date ?? 'date unavailable'}`,
        );
        if (onSelect) {
          cell.addEventListener('click', (event) => {
            event.preventDefault();
            grid.querySelectorAll('.swdb-visual-learning-cell--selected').forEach((selected) => {
              selected.classList.remove('swdb-visual-learning-cell--selected');
              selected.removeAttribute('aria-current');
            });
            cell.classList.add('swdb-visual-learning-cell--selected');
            cell.setAttribute('aria-current', 'true');
            onSelect(session);
          });
        }
        grid.appendChild(cell);
      });
      for (let index = subject.sessions.length; index < maxSessions; index += 1) {
        const empty = document.createElement('span');
        empty.className = 'swdb-visual-learning-cell swdb-visual-learning-cell--empty';
        empty.setAttribute('aria-hidden', 'true');
        grid.appendChild(empty);
      }
    }

    chart.appendChild(grid);
    mount.replaceChildren(chart);
  }

  function renderLegend(subjects) {
    const present = new Set(subjects.flatMap((subject) => subject.sessions.map((session) => session.stage.key)));
    legend.replaceChildren(...STAGE_GROUPS.filter((group) => present.has(group.key)).map((group) => {
      const item = document.createElement('span');
      item.className = 'swdb-visual-learning-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'swdb-visual-learning-swatch';
      swatch.style.backgroundColor = group.color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(group.label));
      return item;
    }));
    if (present.has(UNKNOWN_STAGE.key)) {
      const item = document.createElement('span');
      item.className = 'swdb-visual-learning-legend-item';
      const swatch = document.createElement('span');
      swatch.className = 'swdb-visual-learning-swatch';
      swatch.style.backgroundColor = UNKNOWN_STAGE.color;
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(UNKNOWN_STAGE.label));
      legend.appendChild(item);
    }
  }

  return {
    element: section,
    async load(assets) {
      controller?.abort();
      controller = new AbortController();
      mount.innerHTML = '<div class="swdb-panel-status">Loading training stages…</div>';
      try {
        const rows = await loadVisualLearningProgression(assets, { signal: controller.signal });
        if (controller.signal.aborted) return;
        render(rows);
      } catch (error) {
        if (controller.signal.aborted) return;
        mount.innerHTML = '<div class="swdb-panel-status swdb-panel-status--error">Could not load training stages.</div>';
        console.error('[SWDB] Visual Learning progression load failed', error);
      }
    },
    dispose() {
      controller?.abort();
    },
  };
}
