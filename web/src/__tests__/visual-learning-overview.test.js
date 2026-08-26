/**
 * visual-learning-overview.test.js — pure and DOM coverage for the Visual
 * Learning training-stage progression chart.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../swdb/data.js', () => ({
  loadVisualLearningProgression: vi.fn(),
}));

import { loadVisualLearningProgression } from '../swdb/data.js';
import {
  buildVisualLearningProgressionRows,
  createVisualLearningOverview,
  visualLearningStage,
} from '../swdb/visual-learning-overview.js';

const session = (overrides = {}) => ({
  asset_name: 'multiplane-ophys_782149_2025-03-25_09-46-08_processed_2026-08-19_00-32-51',
  subject_id: '782149',
  session_date: '2025-03-25T16:46:08Z',
  session_type: 'TRAINING_0_gratings_A',
  ...overrides,
});

describe('visualLearningStage', () => {
  it('maps the session types to the slide-like progression groups', () => {
    expect(visualLearningStage('TRAINING_0_gratings_A').key).toBe('static-gratings');
    expect(visualLearningStage('TRAINING_3_images_A_10uL_reward').key).toBe('flashed-images');
    expect(visualLearningStage('OPHYS_4_images_A').key).toBe('novel-images');
    expect(visualLearningStage('STAGE_1').key).toBe('natural-movies');
    expect(visualLearningStage(null).key).toBe('unclassified');
  });
});

describe('buildVisualLearningProgressionRows', () => {
  it('groups by subject and orders sessions chronologically', () => {
    const rows = buildVisualLearningProgressionRows([
      session({ asset_name: 'late', subject_id: '2', session_date: '2025-04-02', session_type: 'OPHYS_1' }),
      session({ asset_name: 'early', subject_id: '2', session_date: '2025-03-25' }),
      session({ asset_name: 'other', subject_id: '1', session_date: '2025-04-01', session_type: 'STAGE_0' }),
    ]);

    expect(rows.map((row) => row.subjectId)).toEqual(['2', '1']);
    expect(rows[0].sessions.map((row) => row.asset_name)).toEqual(['early', 'late']);
    expect(rows[0].sessions[1].stage.key).toBe('familiar-images');
  });
});

describe('createVisualLearningOverview', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('renders one colored cell sequence per subject', async () => {
    loadVisualLearningProgression.mockResolvedValue([
      session(),
      session({
        asset_name: 'second',
        session_date: '2025-04-02',
        session_type: 'OPHYS_1',
      }),
      session({
        asset_name: 'another-mouse',
        subject_id: '788406',
        session_date: '2025-05-29',
        session_type: 'STAGE_1',
      }),
    ]);

    const overview = createVisualLearningOverview({});
    document.body.appendChild(overview.element);
    await overview.load([]);

    expect(overview.element.querySelector('h2').textContent).toBe('Training-stage progression');
    expect(overview.element.querySelectorAll('.swdb-visual-learning-subject')).toHaveLength(2);
    expect(overview.element.querySelectorAll('.swdb-visual-learning-cell:not(.swdb-visual-learning-cell--empty)'))
      .toHaveLength(3);
    expect(overview.element.querySelectorAll('.swdb-visual-learning-legend-item')).toHaveLength(3);
    expect(overview.element.querySelector('.swdb-visual-learning-cell').getAttribute('aria-label'))
      .toContain('Static gratings');
  });

  it('selects a session through the callback while retaining its asset link', async () => {
    const onSelect = vi.fn();
    loadVisualLearningProgression.mockResolvedValue([session()]);

    const overview = createVisualLearningOverview({}, { onSelect });
    document.body.appendChild(overview.element);
    await overview.load([]);

    const cell = overview.element.querySelector('.swdb-visual-learning-cell');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    cell.dispatchEvent(event);

    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ asset_name: session().asset_name }));
    expect(cell.classList.contains('swdb-visual-learning-cell--selected')).toBe(true);
    expect(cell.getAttribute('aria-current')).toBe('true');
    expect(event.defaultPrevented).toBe(true);
  });
});
