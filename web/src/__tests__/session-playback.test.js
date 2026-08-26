import { describe, expect, it } from 'vitest';
import {
  isDynamicRoutingEcephys,
  isMfishProject,
} from '../lib/behaviors/session-playback.js';

describe('Visual Learning playback routing', () => {
  it('recognizes mFISH and Visual Learning project-name variants', () => {
    expect(isMfishProject('LearningmFISHTask1A')).toBe(true);
    expect(isMfishProject('Visual Learning')).toBe(true);
    expect(isMfishProject('Visual Coding Ophys')).toBe(false);
  });
});

describe('Dynamic Routing ecephys Data-tab section eligibility', () => {
  it('matches Dynamic Routing acquisitions with ecephys', () => {
    expect(isDynamicRoutingEcephys({
      type: 'Acquisition',
      modalities: ['behavior', 'ecephys'],
      data: { _project_name: 'Dynamic Routing' },
    })).toBe(true);
  });

  it('does not match behavior-only Dynamic Routing acquisitions', () => {
    expect(isDynamicRoutingEcephys({
      type: 'Acquisition',
      modalities: ['behavior'],
      data: { _project_name: 'Dynamic Routing' },
    })).toBe(false);
  });

  it('does not match ecephys from another project', () => {
    expect(isDynamicRoutingEcephys({
      type: 'Acquisition',
      modalities: ['behavior', 'ecephys'],
      data: { _project_name: 'Visual Coding' },
    })).toBe(false);
  });
});
