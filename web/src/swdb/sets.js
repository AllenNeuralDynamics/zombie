/**
 * swdb/sets.js — presentation metadata for the curated SWDB sets.
 *
 * Membership itself lives in the cache (`platform_swdb_sessions.set_id`), written by
 * the `swdb` job from its hardcoded `SWDB_SETS`. This module only holds the
 * human-facing copy for each set id, so adding a set means one entry here plus the
 * asset list in `biodata-cache`. Unknown set ids still render, using the id as the
 * title, so a cache that runs ahead of the frontend degrades instead of breaking.
 */

/** Per-set display copy, keyed by the cache's `set_id`. */
export const SWDB_SETS = {
  'dynamic-routing': {
    title: 'Dynamic Routing',
    blurb:
      'Merged NWB sessions from the visual/auditory task-switching project. Each file combines '
      + 'behavior trials, DLC eye tracking, receptive-field mapping, optotagging and sorted units.',
    task: 'Dynamic Routing',
  },
  'neuropixels-opto': {
    title: 'Neuropixels Opto',
    blurb:
      'Merged NWB sessions combining electrophysiology with optogenetic tagging across many '
      + 'subjects.',
    task: 'Neuropixels Opto',
  },
  'v1dd': {
    title: 'V1DD',
    blurb:
      'Multiplane-ophys sessions from the V1 Deep Dive project, filtered to ROIs likely to be '
      + 'somas.',
    task: 'V1 Deep Dive',
  },
  'brain-computer-interface': {
    title: 'Brain-Computer Interface',
    blurb: 'Single-plane-ophys sessions from the Brain-Computer Interface project.',
    task: 'Brain-Computer Interface',
  },
};

/**
 * Return display copy for a set id, falling back to the raw id.
 *
 * @param {string} setId
 * @returns {{title: string, blurb: string, task: string|null}}
 */
export function setInfo(setId) {
  return SWDB_SETS[setId] ?? { title: setId, blurb: '', task: null };
}

/**
 * Group session-catalog rows into sets and summarise each one for a card.
 *
 * @param {object[]} sessions - Rows from `platform_swdb_sessions`.
 * @returns {object[]} One summary per set, in cache order.
 */
export function summariseSets(sessions) {
  const bySet = new Map();
  for (const row of sessions) {
    const setId = row.set_id ?? 'unknown';
    if (!bySet.has(setId)) bySet.set(setId, []);
    bySet.get(setId).push(row);
  }

  return [...bySet.entries()].map(([setId, rows]) => {
    const num = (key) => rows.reduce((sum, r) => sum + (Number(r[key]) || 0), 0);
    const dates = rows.map((r) => r.session_date).filter(Boolean).sort();
    return {
      setId,
      ...setInfo(setId),
      rows,
      nAssets: rows.length,
      nSubjects: new Set(rows.map((r) => String(r.subject_id))).size,
      nTrials: num('n_trials'),
      nUnits: num('n_units'),
      nLicks: num('n_licks'),
      totalHours: num('session_duration_s') / 3600,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      modalities: {
        behavior: rows.some((r) => Number(r.n_trials) > 0),
        eye: rows.some((r) => r.has_eye_tracking),
        units: rows.some((r) => r.has_units),
        optotagging: rows.some((r) => r.has_optotagging),
        rfMapping: rows.some((r) => r.has_rf_mapping),
      },
    };
  });
}
