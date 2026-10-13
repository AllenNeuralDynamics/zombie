import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTHOR_WORKFLOW_LEVELS,
  enabledAuthorWorkflowLevels,
  normalizeAuthorWorkflowLevels,
  workflowLevelLabel,
  workflowUiValueToStored,
  workflowValueToUiValue,
} from '../contributions/author-workflow-levels.js';

describe('author workflow levels', () => {
  it('uses the built-in definitions when a project has no custom options', () => {
    const levels = normalizeAuthorWorkflowLevels(null);
    expect(levels.map(({ label }) => label)).toEqual(['+', '++', 'Lead']);
    expect(levels.map(({ enabled }) => enabled)).toEqual([true, true, true]);
    expect(levels[0].description).toContain('supporting contribution');
  });

  it('honors legacy flags and allows a custom enabled subset', () => {
    const legacy = normalizeAuthorWorkflowLevels(null, { allow_lead: false, allow_levels: true });
    expect(enabledAuthorWorkflowLevels(legacy).map(({ value }) => value))
      .toEqual(['equal', 'supporting']);

    const limited = normalizeAuthorWorkflowLevels([
      { value: 'basic', label: 'Basic', enabled: false, color: '#112233' },
      { value: 'major', label: 'Major', enabled: true, color: '#445566' },
    ]);
    expect(enabledAuthorWorkflowLevels(limited).map(({ value }) => value)).toEqual(['major']);
    expect(workflowLevelLabel('major', limited)).toBe('Major');
  });

  it('round-trips built-in and custom values between the editor and API', () => {
    expect(workflowUiValueToStored('Lead')).toBe('lead');
    expect(workflowValueToUiValue('supporting')).toBe('Supporting');
    const custom = [{ value: 'custom-substantial', label: 'Substantial', enabled: true }];
    expect(workflowUiValueToStored('custom-substantial', custom)).toBe('custom-substantial');
    expect(workflowValueToUiValue('custom-substantial', custom)).toBe('custom-substantial');
    expect(DEFAULT_AUTHOR_WORKFLOW_LEVELS).toHaveLength(3);
  });
});
