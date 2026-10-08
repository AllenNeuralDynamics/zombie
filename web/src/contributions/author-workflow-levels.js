/** Shared defaults and conversions for project-configured author workflow levels. */

export const DEFAULT_AUTHOR_WORKFLOW_LEVELS = [
  {
    value: 'supporting',
    label: '+',
    description: 'indicates a supporting contribution, which may not warrant authorship',
    color: '#9ca3af',
    enabled: true,
  },
  {
    value: 'equal',
    label: '++',
    description: 'indicates a major contribution to a specific CRediT role',
    color: '#818cf8',
    enabled: true,
  },
  {
    value: 'lead',
    label: 'Lead',
    description: 'indicates that the author was both a major contributor and the primary coordinator of this CRediT role, not all papers have authors at the lead level',
    color: '#4338ca',
    enabled: true,
  },
];

const DEFAULT_LEVEL_COLORS = Object.fromEntries(
  DEFAULT_AUTHOR_WORKFLOW_LEVELS.map((level) => [level.value, level.color]),
);

/** Keep the original matrix shades until a project customizes its level colors. */
export function usesLegacyAuthorWorkflowColors(levels) {
  return (levels || []).every((level) => (
    level && Object.hasOwn(DEFAULT_LEVEL_COLORS, level.value)
    && level.color === DEFAULT_LEVEL_COLORS[level.value]
  ));
}

const BUILTIN_UI_VALUES = {
  lead: 'Lead',
  equal: 'Equal',
  supporting: 'Supporting',
};

const BUILTIN_LABELS = { lead: 'Lead', equal: '++', supporting: '+' };

const LEGACY_LABEL_VALUES = Object.fromEntries(
  Object.entries(BUILTIN_UI_VALUES).map(([value, label]) => [label.toLowerCase(), value]),
);

/** Resolve absent settings to defaults, while honoring legacy allow flags. */
export function normalizeAuthorWorkflowLevels(levels, legacy = {}) {
  if (Array.isArray(levels)) {
    return levels
      .filter((level) => level && typeof level === 'object' && String(level.value || '').trim())
      .map((level) => ({
        value: String(level.value).trim(),
        label: String(level.label ?? level.value).trim(),
        description: String(level.description ?? ''),
        color: /^#[0-9a-f]{6}$/i.test(level.color) ? level.color : '#818cf8',
        enabled: level.enabled !== false,
      }));
  }

  legacy ||= {};
  const allowLevels = legacy.allowLevels ?? legacy.allow_levels ?? true;
  const allowLead = legacy.allowLead ?? legacy.allow_lead ?? true;
  return DEFAULT_AUTHOR_WORKFLOW_LEVELS.map((level) => ({
    ...level,
    enabled: Boolean(allowLevels && (level.value !== 'lead' || allowLead)),
  }));
}

/** Return enabled options in the usual strongest-first order for legacy tiers. */
export function enabledAuthorWorkflowLevels(levels) {
  const enabled = availableAuthorWorkflowLevels(levels);
  const rank = { lead: 0, equal: 1, supporting: 2 };
  return enabled.sort((a, b) => {
    const aRank = rank[a.value];
    const bRank = rank[b.value];
    if (aRank != null && bRank != null) return aRank - bRank;
    if (aRank != null) return -1;
    if (bRank != null) return 1;
    return 0;
  });
}

/** Return available options in the order configured for the project. */
export function availableAuthorWorkflowLevels(levels) {
  return (levels || []).filter((level) => level.enabled !== false);
}

/** Convert a stored value to the editor's legacy display value when applicable. */
export function workflowValueToUiValue(value, levels = DEFAULT_AUTHOR_WORKFLOW_LEVELS) {
  const stored = String(value ?? '').trim();
  if (!stored || stored.toLowerCase() === 'none') return 'None';
  const canonical = LEGACY_LABEL_VALUES[stored.toLowerCase()] || stored.toLowerCase();
  if (BUILTIN_UI_VALUES[canonical]) return BUILTIN_UI_VALUES[canonical];
  return levels.find((level) => level.value === stored || level.value === canonical)?.value || stored;
}

/** Convert editor values to the backend's stable value; custom values pass through. */
export function workflowUiValueToStored(value, levels = DEFAULT_AUTHOR_WORKFLOW_LEVELS) {
  const uiValue = String(value ?? '').trim();
  if (!uiValue || uiValue.toLowerCase() === 'none') return '';
  const canonical = LEGACY_LABEL_VALUES[uiValue.toLowerCase()] || uiValue.toLowerCase();
  if (BUILTIN_UI_VALUES[canonical]) return canonical;
  return levels.find((level) => level.value === uiValue || level.value === canonical)?.value || uiValue;
}

export function workflowLevelOption(value, levels = DEFAULT_AUTHOR_WORKFLOW_LEVELS) {
  const stored = workflowUiValueToStored(value, levels);
  return (levels || []).find((level) => level.value === stored);
}

export function workflowLevelLabel(value, levels = DEFAULT_AUTHOR_WORKFLOW_LEVELS) {
  const option = workflowLevelOption(value, levels);
  if (option) return option.label;
  const stored = workflowUiValueToStored(value, levels);
  if (BUILTIN_LABELS[stored]) return BUILTIN_LABELS[stored];
  if (stored.startsWith('custom-')) {
    const readable = stored.slice('custom-'.length).replace(/-[a-z0-9]{8}$/, '').replace(/-/g, ' ');
    return readable.replace(/\b\w/g, (character) => character.toUpperCase());
  }
  return String(value ?? '');
}

export function workflowLevelColor(value, levels = DEFAULT_AUTHOR_WORKFLOW_LEVELS) {
  return workflowLevelOption(value, levels)?.color || '#9ca3af';
}

export function createWorkflowLevelValue(label, levels = []) {
  const base = String(label || 'level').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'level';
  const used = new Set((levels || []).map((level) => level.value));
  const entropy = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  let value = `custom-${base}-${entropy.slice(0, 8)}`;
  let suffix = 2;
  const candidate = value;
  while (used.has(value)) value = `${candidate}-${suffix++}`;
  return value;
}
