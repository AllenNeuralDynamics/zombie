/**
 * mfish/behavior-events.js — one normalized behavior-events loader for every
 * Learning-mFISH training/ophys stage, hiding the (considerable) differences
 * between the two behavior-NWB layouts these sessions ship in.
 *
 * See MFISH_NWB_MESS.md for the gory details. In short there are two variants:
 *
 *   'gratings'  (TRAINING_0/1/2 …): behavior asset `<raw>_processed_<ts>`,
 *       inner `<raw>.nwb`; stimuli in `intervals/grating_presentations`;
 *       licks in `acquisition/licks`; rewards in `acquisition/reward_volume`;
 *       running in `processing/running/running_speed`.
 *
 *   'images'    (TRAINING_3+/OPHYS_*): behavior asset `<raw>_behavior-nwb_<ts>`,
 *       inner `behavior.nwb.zarr`; stimuli in `intervals/stimulus_presentations`;
 *       a full change-detection `intervals/trials` table (change_time /
 *       reward_time / hit / miss / …); licks may be in
 *       `processing/behavior/licks`; running is in `processing/running/speed`.
 *
 * The variant is detected by probing which intervals table exists. The inner
 * NWB name is discovered from the derived asset's S3 prefix when possible;
 * older processed assets use several different names, so guessing it from
 * the raw acquisition is not reliable.
 *
 * Output — a single normalized shape both the behavior player and the pophys
 * PSTH consume:
 *   {
 *     variant, baseUrl, sessionEndS,
 *     stimuli: [{ t, tEnd, label, ori, isChange, omitted }],
 *     changes: Float64Array,          // stimulus/orientation change onsets
 *     rewards: Float64Array,
 *     licks:   Float64Array | null,   // null when the NWB has no lick stream
 *     running: { t: Float64Array, v: Float64Array },
 *     counts:  { stimuli, changes, rewards, licks },
 *   }
 */

import * as zarr from 'zarrita';
import { s3LocationToHttps } from '../lib/behaviors/playback-video.js';
import { resolveLatestDerived } from '../lib/raw-to-derived.js';

// Running speed is decimated for display at a fixed rate rather than a fixed
// total point budget, so resolution stays constant (comparable to the ~10 Hz
// dF/F trace it's plotted alongside) regardless of session length. The old
// fixed-3000-point budget worked out to ~1 Hz for a typical ~50 min session.
const RUNNING_TARGET_HZ = 10;
const RUNNING_MAX_POINTS = 200_000; // safety ceiling, not the normal control
const S3_NWB_LIST_MAX_KEYS = 1000;
const nwbBaseCache = new Map();

function xmlUnescape(value) {
  return String(value ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Find an NWB-Zarr directory immediately below an asset prefix.
 *
 * The public behavior capsules have used all of these forms over time:
 *   <asset>/behavior.nwb.zarr/
 *   <asset>/<raw>.nwb/
 *   <asset>/<session>.nwb.zarr/
 * Keep this parser independent of the S3 client so it can be tested without
 * a live bucket.
 */
export function findBehaviorNwbPrefix(xml, assetKey) {
  const prefix = `${String(assetKey ?? '').replace(/^\/+|\/+$/g, '')}/`;
  const roots = [
    ...String(xml ?? '').matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g),
  ]
    .map((m) => xmlUnescape(m[1]))
    .filter((key) => key.startsWith(prefix) && /\.nwb(?:\.zarr)?\/$/i.test(key))
    .sort((a, b) => {
      // Prefer an explicit Zarr suffix, then the conventional behavior name.
      const rank = (key) => (/behavior\.nwb\.zarr\/$/i.test(key) ? 0
        : /\.nwb\.zarr\/$/i.test(key) ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  return roots[0] ?? null;
}

function s3ListUrl(baseUrl, relativePrefix = '') {
  const u = new URL(baseUrl);
  const key = u.pathname.replace(/^\/+|\/+$/g, '');
  const suffix = String(relativePrefix).replace(/^\/+|\/+$/g, '');
  const prefix = suffix ? `${key}/${suffix}/` : `${key}/`;
  return `${u.origin}/?list-type=2&prefix=${encodeURIComponent(prefix)}`
    + `&delimiter=${encodeURIComponent('/')}&max-keys=${S3_NWB_LIST_MAX_KEYS}`;
}

/**
 * Extract stimulus-template group names from an S3 delimiter listing.
 *
 * The group is the image-set name (for example
 * `Natural_Images_Lum_Matched_set_training_2017.07.14`). Keeping this
 * discovery separate from the loader makes the browser-side template path
 * testable without opening a Zarr store.
 */
export function findStimulusTemplateGroups(xml, baseUrl) {
  const u = new URL(baseUrl);
  const baseKey = u.pathname.replace(/^\/+|\/+$/g, '');
  const marker = `${baseKey}/stimulus/templates/`;
  return [...String(xml ?? '').matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  )]
    .map((match) => xmlUnescape(match[1]))
    .filter((key) => key.startsWith(marker))
    .map((key) => key.slice(marker.length).replace(/\/$/, ''))
    .filter(Boolean)
    .sort();
}

/** Discover the behavior NWB root rather than relying on a filename guess. */
async function discoverBehaviorNwbBase(baseUrl, { signal } = {}) {
  if (nwbBaseCache.has(baseUrl)) return nwbBaseCache.get(baseUrl);
  const promise = (async () => {
    const listResp = await fetch(s3ListUrl(baseUrl), { signal });
    if (!listResp.ok) throw new Error(`behavior NWB listing failed (${listResp.status})`);
    const u = new URL(baseUrl);
    const assetKey = u.pathname.replace(/^\/+|\/+$/g, '');
    const rootPrefix = findBehaviorNwbPrefix(await listResp.text(), assetKey);
    if (!rootPrefix) throw new Error('no behavior NWB-Zarr root found');
    return `${u.origin}/${rootPrefix.replace(/\/$/, '')}`;
  })();
  nwbBaseCache.set(baseUrl, promise);
  try {
    return await promise;
  } catch (err) {
    nwbBaseCache.delete(baseUrl);
    throw err;
  }
}

/** Resolve the behavior NWB base URL + variant hint for a raw acquisition. */
export async function resolveBehaviorNwb(coord, rawAssetName, { signal } = {}) {
  if (!coord || !rawAssetName) return null;
  const row = await resolveLatestDerived(coord, rawAssetName, { modality: 'behavior' });
  if (!row) return null;
  const base = s3LocationToHttps(row.location);
  if (!base) return null;
  // The listing is authoritative. Retain the historical guess as a fallback
  // for buckets that do not permit listing (and for local test doubles).
  let nwbBase;
  try {
    nwbBase = await discoverBehaviorNwbBase(base, { signal });
  } catch {
    const inner = /_behavior-nwb_/.test(row.name) ? 'behavior.nwb.zarr' : `${rawAssetName}.nwb`;
    nwbBase = `${base}/${inner}`;
  }
  return { name: row.name, baseUrl: nwbBase };
}

async function tryArray(root, path, signal) {
  try {
    const arr = await zarr.open(root.resolve(path), { kind: 'array' });
    const chunk = await zarr.get(arr, null, { signal });
    if (signal?.aborted) throw new Error('aborted');
    return chunk.data;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function tryOpenArray(root, path, signal) {
  try {
    return await zarr.open(root.resolve(path), { kind: 'array' });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function tryArrayChunk(root, path, selection, signal) {
  const array = await tryOpenArray(root, path, signal);
  if (!array) return null;
  try {
    const chunk = await zarr.get(array, selection, { signal });
    if (signal?.aborted) throw new Error('aborted');
    return { data: chunk?.data ?? chunk, shape: chunk?.shape ?? array.shape ?? null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

function toF64Sorted(a) {
  const out = Float64Array.from(a, Number);
  out.sort();
  return out;
}

function parseOri(name) {
  const m = String(name).match(/(-?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) % 360 : null;
}

function downsample(times, vals) {
  const n = Math.min(times.length, vals.length);
  if (n === 0) return { t: new Float64Array(), v: new Float64Array() };
  const span = Math.max(Number(times[n - 1]) - Number(times[0]), 1e-9);
  const targetPoints = Math.min(RUNNING_MAX_POINTS, Math.max(1, Math.round(span * RUNNING_TARGET_HZ)));
  const step = Math.max(1, Math.floor(n / targetPoints));
  const t = [], v = [];
  for (let i = 0; i < n; i += step) {
    const ti = Number(times[i]), vi = Number(vals[i]);
    if (Number.isFinite(ti) && Number.isFinite(vi)) { t.push(ti); v.push(vi); }
  }
  return { t: Float64Array.from(t), v: Float64Array.from(v) };
}

/**
 * Load + normalize behavior events for one mFISH session.
 * @returns {Promise<object|null>} normalized events, or null if unresolved.
 */
export async function loadBehaviorEvents(coord, rawAssetName, { signal } = {}) {
  const resolved = await resolveBehaviorNwb(coord, rawAssetName, { signal });
  if (!resolved) return null;
  if (signal?.aborted) throw new Error('aborted');
  const events = await loadBehaviorEventsFromUrl(resolved.baseUrl, { signal });
  return { ...events, name: resolved.name };
}

/**
 * Load + normalize behavior events from a behavior-NWB base URL, detecting the
 * variant by probing the stimulus table. Exposed separately so it can be used
 * (and tested) without a DuckDB coordinator.
 */
export async function loadBehaviorEventsFromUrl(baseUrl, { signal } = {}) {
  const root = zarr.root(new zarr.FetchStore(baseUrl));

  // Variant detection by probing the stimulus table.
  const gratingStart = await tryArray(root, 'intervals/grating_presentations/start_time', signal);
  const variant = gratingStart ? 'gratings' : 'images';

  const out = variant === 'gratings'
    ? await _loadGratings(root, gratingStart, signal)
    : await _loadImages(root, signal);

  return { variant, baseUrl, ...out };
}

/**
 * Create a lazy reader for the image templates associated with a behavior NWB.
 *
 * Template stacks can be tens of megabytes, so they must not be included in
 * the initial event read. The first request lists the template groups and
 * reads only the requested image plane; subsequent requests for the same
 * image are served from the in-memory promise cache.
 *
 * The returned object is intentionally small so it can be passed through the
 * shared mFISH player without making the playback harness aware of NWB.
 *
 * @param {string} baseUrl - Behavior NWB-Zarr root URL.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {{ get: (imageName: string) => Promise<object|null> }}
 */
export function createStimulusTemplateLoader(baseUrl, { signal } = {}) {
  const root = zarr.root(new zarr.FetchStore(baseUrl));
  const imageCache = new Map();
  const groupCache = new Map();
  let groupsPromise = null;

  const discoverGroups = () => {
    if (!groupsPromise) {
      groupsPromise = (async () => {
        const response = await fetch(s3ListUrl(baseUrl, 'stimulus/templates'), { signal });
        if (!response.ok) throw new Error(`stimulus template listing failed (${response.status})`);
        return findStimulusTemplateGroups(await response.text(), baseUrl);
      })();
    }
    return groupsPromise;
  };

  const loadGroup = (group) => {
    if (groupCache.has(group)) return groupCache.get(group);
    const promise = (async () => {
      const prefix = `stimulus/templates/${group}`;
      const namesChunk = await firstArrayChunk(root, [
        `${prefix}/control_description`,
        `${prefix}/image_name`,
        `${prefix}/image_names`,
      ], signal);
      if (!namesChunk) return null;
      const names = Array.from(namesChunk.data ?? [], templateName);
      if (!names.length) return null;
      return { prefix, names };
    })();
    groupCache.set(group, promise);
    return promise;
  };

  const loadImage = async (imageName) => {
    if (signal?.aborted) throw new Error('aborted');
    const target = templateName(imageName);
    if (!target) return null;

    for (const group of await discoverGroups()) {
      const metadata = await loadGroup(group);
      if (!metadata) continue;
      const index = metadata.names.findIndex((name) => name === target);
      if (index < 0) continue;

      // Current Visual Behavior NWB-Zarr uses `data`; the other candidates
      // cover older conversions that exposed the warped/unwarped arrays as
      // nested groups. Prefer the display-ready warped data when available.
      for (const path of [
        `${metadata.prefix}/data`,
        `${metadata.prefix}/warped`,
        `${metadata.prefix}/warped/data`,
        `${metadata.prefix}/unwarped`,
        `${metadata.prefix}/unwarped/data`,
      ]) {
        const array = await tryOpenArray(root, path, signal);
        if (!array) continue;
        const rank = Array.isArray(array.shape) ? array.shape.length : 3;
        if (rank < 2) continue;
        const selection = [index, ...Array.from({ length: rank - 1 }, () => null)];
        const chunk = await tryArrayChunk(root, path, selection, signal);
        if (chunk) return chunk;
      }
    }
    return null;
  };

  return {
    get(imageName) {
      const target = templateName(imageName);
      if (!target) return Promise.resolve(null);
      if (!imageCache.has(target)) {
        const promise = loadImage(target).catch((error) => {
          // Missing template groups, ACL/CORS failures, and older incomplete
          // derivatives should leave the player usable with its label
          // fallback. Aborts still need to stop the active playback load.
          if (signal?.aborted) throw error;
          return null;
        });
        imageCache.set(target, promise);
      }
      return imageCache.get(target);
    },
  };
}

async function firstArrayChunk(root, paths, signal) {
  for (const path of paths) {
    const chunk = await tryArrayChunk(root, path, null, signal);
    if (chunk) return chunk;
    if (signal?.aborted) throw new Error('aborted');
  }
  return null;
}

function templateName(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).trim();
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Variant loaders
// ---------------------------------------------------------------------------

async function _loadGratings(root, gStart, signal) {
  const [gStop, gImg, lickT, rewT, rewV, runT, runV] = await Promise.all([
    tryArray(root, 'intervals/grating_presentations/stop_time', signal),
    tryArray(root, 'intervals/grating_presentations/image_name', signal),
    firstArray(root, ['acquisition/licks/timestamps', 'processing/behavior/licks/timestamps'], signal),
    firstArray(root, ['acquisition/reward_volume/timestamps', 'processing/behavior/rewards/timestamps'], signal),
    tryArray(root, 'acquisition/reward_volume/data', signal),
    firstArray(root, ['processing/running/running_speed/timestamps', 'processing/running/speed/timestamps'], signal),
    firstArray(root, ['processing/running/running_speed/data', 'processing/running/speed/data'], signal),
  ]);

  const stimuli = [];
  for (let i = 0; i < gStart.length; i++) {
    const t = Number(gStart[i]);
    if (!Number.isFinite(t)) continue;
    stimuli.push({
      t,
      tEnd: gStop ? Number(gStop[i]) : t,
      label: gImg ? String(gImg[i]) : '',
      ori: gImg ? parseOri(gImg[i]) : null,
      isChange: false,
      omitted: false,
    });
  }
  stimuli.sort((a, b) => a.t - b.t);

  // Orientation-change onsets.
  const changesArr = [];
  let prev = null;
  for (const s of stimuli) { if (s.ori !== prev) { s.isChange = true; changesArr.push(s.t); } prev = s.ori; }

  const licks = lickT ? toF64Sorted(lickT) : null;
  const rewards = _rewardsFromVolume(rewT, rewV);
  const running = runT && runV ? downsample(runT, runV) : { t: new Float64Array(), v: new Float64Array() };

  return _finish(stimuli, changesArr, rewards, licks, running);
}

async function _loadImages(root, signal) {
  const [sStart, sStop, sImg, sChange, sOmit, sOri,
    chTime, rewTime, lickT, rewAcqT, rewAcqV, runT, runV] = await Promise.all([
    tryArray(root, 'intervals/stimulus_presentations/start_time', signal),
    tryArray(root, 'intervals/stimulus_presentations/stop_time', signal),
    tryArray(root, 'intervals/stimulus_presentations/image_name', signal),
    tryArray(root, 'intervals/stimulus_presentations/is_change', signal),
    tryArray(root, 'intervals/stimulus_presentations/omitted', signal),
    tryArray(root, 'intervals/stimulus_presentations/orientation', signal),
    tryArray(root, 'intervals/trials/change_time', signal),
    tryArray(root, 'intervals/trials/reward_time', signal),
    firstArray(root, ['processing/behavior/licks/timestamps', 'acquisition/licks/timestamps'], signal),
    firstArray(root, ['acquisition/reward_volume/timestamps', 'processing/behavior/rewards/timestamps'], signal),
    tryArray(root, 'acquisition/reward_volume/data', signal),
    firstArray(root, ['processing/running/speed/timestamps', 'processing/running/running_speed/timestamps'], signal),
    firstArray(root, ['processing/running/speed/data', 'processing/running/running_speed/data'], signal),
  ]);

  if (!sStart) {
    throw new Error('Behavior NWB has no stimulus_presentations/start_time array');
  }

  const stimuli = [];
  const changesArr = [];
  for (let i = 0; i < (sStart?.length ?? 0); i++) {
    const t = Number(sStart[i]);
    if (!Number.isFinite(t)) continue;
    const isChange = !!(sChange && Number(sChange[i]));
    stimuli.push({
      t,
      tEnd: sStop ? Number(sStop[i]) : t,
      label: sImg ? String(sImg[i]) : '',
      ori: sOri && Number.isFinite(Number(sOri[i])) ? Number(sOri[i]) : null,
      isChange,
      omitted: !!(sOmit && Number(sOmit[i])),
    });
    if (isChange) changesArr.push(t);
  }
  stimuli.sort((a, b) => a.t - b.t);

  // Prefer trials.change_time for the change stream when present.
  if (chTime) {
    changesArr.length = 0;
    for (const t of chTime) if (Number.isFinite(Number(t))) changesArr.push(Number(t));
  }

  const trialRewards = rewTime
    ? Array.from(rewTime, Number).filter(Number.isFinite)
    : [];
  const acquisitionRewards = rewAcqT
    ? _rewardsFromVolume(rewAcqT, rewAcqV)
    : new Float64Array();
  const rewards = trialRewards.length ? toF64Sorted(trialRewards) : acquisitionRewards;
  const running = runT && runV ? downsample(runT, runV) : { t: new Float64Array(), v: new Float64Array() };

  // Older Visual Behavior NWBs store licks in processing/behavior; some
  // processed mFISH assets retain the acquisition TimeSeries instead.
  const licks = lickT ? toF64Sorted(lickT) : null;
  return _finish(stimuli, changesArr, rewards, licks, running);
}

/** Resolve the first available array from a list of historical NWB paths. */
async function firstArray(root, paths, signal) {
  for (const path of paths) {
    const value = await tryArray(root, path, signal);
    if (value != null) return value;
    if (signal?.aborted) throw new Error('aborted');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

function _rewardsFromVolume(rewT, rewV) {
  if (!rewT) return new Float64Array();
  const t = [];
  for (let i = 0; i < rewT.length; i++) {
    const vol = rewV ? Number(rewV[i]) : 1;
    if (Number.isFinite(Number(rewT[i])) && (!rewV || vol > 0)) t.push(Number(rewT[i]));
  }
  return toF64Sorted(t);
}

function _finish(stimuli, changesArr, rewards, licks, running) {
  const changes = toF64Sorted(changesArr);
  const maxes = [
    stimuli.length ? stimuli[stimuli.length - 1].tEnd : 0,
    licks && licks.length ? licks[licks.length - 1] : 0,
    rewards.length ? rewards[rewards.length - 1] : 0,
    running.t.length ? running.t[running.t.length - 1] : 0,
  ].filter(Number.isFinite);
  const sessionEndS = Math.max(0, ...maxes);
  return {
    sessionEndS,
    stimuli,
    changes,
    rewards,
    licks,
    running,
    counts: {
      stimuli: stimuli.length,
      changes: changes.length,
      rewards: rewards.length,
      licks: licks ? licks.length : null,
    },
  };
}
