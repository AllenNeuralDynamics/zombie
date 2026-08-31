/** @vitest-environment happy-dom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../swdb/data.js', () => ({
  loadVisualLearningProgression: vi.fn(),
  resolveVisualLearningPlaybackSource: vi.fn(),
}));
vi.mock('../mfish/player.js', () => ({
  createMfishSessionPlayback: vi.fn(),
}));

import { loadVisualLearningProgression, resolveVisualLearningPlaybackSource } from '../swdb/data.js';
import { createMfishSessionPlayback } from '../mfish/player.js';
import { createVisualLearningTaskPlayback } from '../swdb/visual-learning-playback.js';

const session = {
  asset_name: 'processed-asset',
  subject_id: '782149',
  session_date: '2025-03-25',
  session_type: 'TRAINING_0_gratings_A',
};

describe('Visual Learning task playback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    loadVisualLearningProgression.mockReturnValue([session]);
    resolveVisualLearningPlaybackSource.mockResolvedValue({
      name: 'raw-task',
      location: 's3://aind-open-data/raw-task',
    });
    createMfishSessionPlayback.mockImplementation((coord, rawName, opts) => {
      const player = document.createElement('div');
      player.className = 'mock-task-player';
      player.rawName = rawName;
      player.options = opts;
      player._dispose = vi.fn();
      player.setSubclassActivity = vi.fn();
      return player;
    });
  });

  it('resolves the task asset and forwards event-plot zoom to the page', async () => {
    const onTimeDomainChange = vi.fn();
    const onTimeChange = vi.fn();
    const playback = createVisualLearningTaskPlayback({}, { onTimeDomainChange, onTimeChange });
    document.body.appendChild(playback.element);
    playback.load([session], { 'processed-asset': ['raw-task'] });

    await playback.select(session, { notify: false });

    expect(resolveVisualLearningPlaybackSource).toHaveBeenCalledWith(
      {}, ['raw-task'], expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(createMfishSessionPlayback).toHaveBeenCalledWith(
      {}, 'raw-task', expect.objectContaining({ acquisitionType: session.session_type }),
    );
    const player = playback.element.querySelector('.mock-task-player');
    player.options.onTimeDomainChange([12, 34]);
    expect(onTimeDomainChange).toHaveBeenCalledWith([12, 34], session);
    player.options.onTimeChange(20);
    expect(onTimeChange).toHaveBeenCalledWith(20, session);
  });

  it('forwards a subclass activity series to the player once it exists', async () => {
    const playback = createVisualLearningTaskPlayback({}, {});
    document.body.appendChild(playback.element);
    playback.load([session], { 'processed-asset': ['raw-task'] });
    await playback.select(session, { notify: false });

    const series = {
      rows: [{ cell_subclass: 'Pvalb', t: 0, activity: 0.1 }],
      subclasses: ['Pvalb'],
      minTime: 0,
      maxTime: 1,
    };
    playback.setSubclassActivity(series);

    const player = playback.element.querySelector('.mock-task-player');
    expect(player.setSubclassActivity).toHaveBeenCalledWith(series);
  });

  it('buffers a subclass activity series set before the player is ready', async () => {
    const playback = createVisualLearningTaskPlayback({}, {});
    document.body.appendChild(playback.element);
    playback.load([session], { 'processed-asset': ['raw-task'] });

    const series = { rows: [], subclasses: [], minTime: 0, maxTime: 0 };
    const selectPromise = playback.select(session, { notify: false });
    playback.setSubclassActivity(series);
    await selectPromise;

    const player = playback.element.querySelector('.mock-task-player');
    expect(player.setSubclassActivity).toHaveBeenCalledWith(series);
  });
});
