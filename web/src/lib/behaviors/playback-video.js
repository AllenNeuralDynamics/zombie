/**
 * playback-video.js — shared behavior-camera video loading + sync for the
 * session-playback harness.
 *
 * AIND behavior rigs store camera captures under the raw asset's
 * `behavior-videos/` folder, but the layout varies across platforms:
 *
 *   1. Per-camera subfolders (VR/Patch foraging Harp rigs):
 *        behavior-videos/<CameraName>/video.<ext>
 *        behavior-videos/<CameraName>/metadata.csv  ← first data column is the
 *          Harp `ReferenceTime` of each frame (row 1 = clock at first frame).
 *
 *   2. Flat MVR (Multi-Video Recorder) files (ecephys / Dynamic Routing rigs):
 *        behavior-videos/<Label>_<timestamp>.<ext>  (e.g. Behavior_…​.mp4)
 *        behavior-videos/<Label>_<timestamp>.json   ← RecordingReport sidecar.
 *      Filenames are timestamped, so they can't be probed by fixed name; they
 *      are discovered by listing the prefix. These have no shared Harp clock,
 *      so their videos are aligned to session t=0 (offset 0).
 *
 * The container format also varies (.mp4 / .avi / .mov / .mkv / .webm).
 *
 * Discovery lists the `behavior-videos/` prefix (works for both layouts) and
 * falls back to probing fixed camera names when the bucket disallows listing.
 * The resulting <video> elements are wired to a playback animation so they
 * stay time-synced during play / pause / scrub. Videos sync only at 1×
 * playback (seeking a <video> every frame at high speed is not useful and
 * hammers the network).
 *
 * The heavy lifting used to live in vr_foraging/player.js; it now backs the
 * Dynamic Foraging and Dynamic Routing players too.
 */

import { withVideoGate } from '../video-gate.js';

// Camera folder names to probe. Superset across the three platforms — cameras
// that don't exist for a given asset are silently skipped.
export const DEFAULT_CAMERAS = [
  'FaceCamera', 'FrontCamera', 'SideCamera',
  'BottomCamera', 'BodyCamera', 'EyeCamera',
];

// Candidate video filenames for the fixed-name probe fallback. Ordered by
// prevalence; the first that resolves wins.
const VIDEO_FILE_CANDIDATES = [
  'video.mp4', 'video.avi', 'video.mov', 'video.mkv', 'video.webm',
];

// Recognised video container extensions (used when parsing an S3 listing).
const VIDEO_EXT_RE = /\.(mp4|avi|mov|mkv|webm)$/i;

/**
 * Collapse duplicate captures that differ only by container extension.
 *
 * Some assets originally recorded `.avi` (etc.) files that were later
 * transcoded to `.mp4` alongside the original. When the same base filename
 * exists in more than one format we only want the `.mp4`; non-mp4 files are
 * kept only when their filename is unique (no `.mp4` counterpart).
 */
function _preferMp4(videoKeys) {
  const mp4Stems = new Set(
    videoKeys
      .filter((k) => /\.mp4$/i.test(k))
      .map((k) => k.replace(VIDEO_EXT_RE, '')),
  );
  return videoKeys.filter((k) => {
    if (/\.mp4$/i.test(k)) return true;
    return !mp4Stems.has(k.replace(VIDEO_EXT_RE, ''));
  });
}

// Only hard-seek a <video> when we drift more than this (avoids constant
// interruption from tiny float imprecision while playing).
const VIDEO_SEEK_THRESHOLD_S = 0.5;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Convert an S3 location (s3://bucket/key) to an HTTPS URL base (no trailing /). */
export function s3LocationToHttps(location) {
  if (!location) return null;
  const m = String(location).match(/^s3:\/\/([^/]+)\/(.+?)\/?$/);
  if (!m) return null;
  const [, bucket, key] = m;
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover the behavior-camera videos under a raw asset base URL.
 *
 * Lists the `behavior-videos/` prefix to discover files regardless of naming
 * convention (per-camera subfolders OR flat timestamped MVR files); falls back
 * to probing fixed camera names when the bucket disallows listing.
 *
 * @param {string} rawBase - HTTPS base URL for the raw asset.
 * @param {object} [opts]
 * @param {string[]} [opts.cameras] - Camera folder names for the probe fallback.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Array<{camera:string, refTime:number, videoUrl:string}>>}
 */
export async function loadCameraVideos(rawBase, { cameras = DEFAULT_CAMERAS, signal } = {}) {
  if (!rawBase) return [];
  const listed = await _listCameraVideos(rawBase, signal);
  if (listed.length) return listed;
  return _probeCameraVideos(rawBase, cameras, signal);
}

/**
 * Discover videos by listing the `behavior-videos/` prefix (S3 ListObjectsV2).
 * Handles both the per-camera-subfolder layout and the flat MVR layout.
 */
async function _listCameraVideos(rawBase, signal) {
  let origin, key;
  try {
    const u = new URL(rawBase);
    origin = u.origin;
    key = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch {
    return [];
  }
  const prefix = `${key}/behavior-videos/`;
  const listUrl =
    `${origin}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;

  let xml;
  try {
    const resp = await fetch(listUrl, { signal });
    if (!resp.ok) return [];
    xml = await resp.text();
  } catch {
    return [];
  }

  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const videoKeys = _preferMp4(keys.filter((k) => VIDEO_EXT_RE.test(k)));
  if (!videoKeys.length) return [];

  const byCamera = new Map();
  for (const k of videoKeys) {
    const rel = k.slice(prefix.length);
    if (!rel) continue;
    if (rel.includes('/')) {
      // Per-camera subfolder layout: behavior-videos/<Camera>/video.<ext>
      const camera = rel.split('/')[0];
      if (byCamera.has(camera)) continue;
      byCamera.set(camera, {
        camera,
        videoUrl: `${origin}/${k}`,
        refTime: null,                     // resolved from metadata.csv below
        _dir: `${rawBase}/behavior-videos/${camera}`,
      });
    } else {
      // Flat MVR layout: behavior-videos/<Label>_<YYYYMMDDThhmmss>.<ext>
      const label = rel.replace(VIDEO_EXT_RE, '');
      const camera = label.replace(/_\d{8}T\d{6}.*$/, '') || label;
      if (byCamera.has(camera)) continue;
      // No shared clock in the flat layout → align the first frame to t=0.
      byCamera.set(camera, { camera, videoUrl: `${origin}/${k}`, refTime: 0 });
    }
  }

  const cams = [...byCamera.values()];
  // Resolve reference times for subfolder-style cameras (Harp clock).
  await Promise.all(cams.map(async (c) => {
    if (c._dir) {
      const rt = await _readReferenceTime(`${c._dir}/metadata.csv`, signal);
      c.refTime = rt ?? 0;
      delete c._dir;
    }
  }));
  return cams.sort((a, b) => a.camera.localeCompare(b.camera));
}

/**
 * Fallback discovery: probe a fixed set of per-camera subfolders for a
 * `metadata.csv` + `video.<ext>` pair. Used when listing is unavailable.
 */
async function _probeCameraVideos(rawBase, cameras, signal) {
  const results = await Promise.all(cameras.map(async (camera) => {
    const dir = `${rawBase}/behavior-videos/${camera}`;
    const refTime = await _readReferenceTime(`${dir}/metadata.csv`, signal);
    if (refTime == null) return null;
    const videoUrl = await _findVideoFile(dir, signal);
    if (!videoUrl) return null;
    return { camera, refTime, videoUrl };
  }));
  return results.filter(Boolean);
}

/**
 * Read the first `ReferenceTime` value from a camera's metadata.csv via an
 * HTTP Range request (only the first ~300 bytes — header + one data row).
 */
async function _readReferenceTime(url, signal) {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-299' }, signal });
    if (!resp.ok) return null;
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    if (lines.length < 2) return null; // header + at least one data row
    const v = parseFloat(lines[1].split(',')[0]);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Probe candidate video filenames; return the first that resolves. */
async function _findVideoFile(dir, signal) {
  for (const name of VIDEO_FILE_CANDIDATES) {
    const url = `${dir}/${name}`;
    try {
      const resp = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
      if (resp.ok || resp.status === 206) return url;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Panel construction
// ---------------------------------------------------------------------------

/**
 * Build one <video> per camera into `container`.
 *
 * @param {HTMLElement} container
 * @param {Array<{camera:string, refTime:number, videoUrl:string}>} cameras
 * @param {number|null} t0 - Reference clock at session t=0. When null, each
 *   video is aligned so its first frame corresponds to session t=0 (offset 0).
 * @returns {Array<{camera:string, video:HTMLVideoElement, offsetS:number}>}
 */
export function buildVideoPanel(container, cameras, t0 = null) {
  const infos = [];
  for (const { camera, refTime, videoUrl } of cameras) {
    // offsetS: seconds into the video file that correspond to session t=0.
    // t0 is the reference clock at t=0; refTime is the clock at the first
    // video frame. When t0 is unknown, fall back to the video's own start.
    const offsetS = (Number.isFinite(t0) ? t0 : refTime) - refTime;

    const wrap = document.createElement('div');
    wrap.className = 'pb-video-wrap';

    const label = document.createElement('div');
    label.className = 'pb-video-label';
    label.textContent = camera.replace('Camera', '');
    wrap.appendChild(label);

    const vid = document.createElement('video');
    vid.src = videoUrl;
    vid.muted = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    vid.className = 'pb-video';
    // Unsupported container format → drop the tile rather than showing a
    // broken player.
    vid.addEventListener('error', () => wrap.remove());
    wrap.appendChild(vid);

    container.appendChild(wrap);
    infos.push({ camera, video: vid, offsetS });
  }
  return infos;
}

// ---------------------------------------------------------------------------
// Sync primitives
// ---------------------------------------------------------------------------

function videoTargetTime(info, sessionT) {
  return info.offsetS + sessionT;
}

function syncVideos(videos, sessionT, playing) {
  if (!videos?.length) return;
  for (const info of videos) {
    const target = videoTargetTime(info, sessionT);
    if (target < 0 || target > (info.video.duration || Infinity)) continue;
    if (!playing) {
      info.video.currentTime = target; // hard-seek so the frame updates
    } else {
      const drift = Math.abs(info.video.currentTime - target);
      if (drift > VIDEO_SEEK_THRESHOLD_S) info.video.currentTime = target;
    }
  }
}

function playVideos(videos, sessionT) {
  if (!videos?.length) return;
  for (const info of videos) {
    const target = videoTargetTime(info, sessionT);
    if (target < 0 || target > (info.video.duration || Infinity)) continue;
    info.video.currentTime = target;
    info.video.play().catch(() => {});
  }
}

function pauseVideos(videos) {
  if (!videos?.length) return;
  for (const { video } of videos) video.pause();
}

// ---------------------------------------------------------------------------
// Animation wiring
// ---------------------------------------------------------------------------

/**
 * Wrap an animation's transport methods so any attached videos stay synced.
 *
 * Videos sync only at 1× playback; at higher speeds they pause and a warning
 * is shown. Call the returned `setVideos(infos)` once the (gated) <video>
 * elements exist.
 *
 * @param {object} anim - Animation with { onFrame, seekTo, play, pause,
 *   setSpeed, playing, speed, t }.
 * @param {object} ctx
 * @param {HTMLElement} ctx.videosEl        - Wrapper shown once videos exist.
 * @param {HTMLElement} [ctx.speedWarningEl]- "1× only" warning element.
 * @returns {(infos:Array)=>void} setVideos
 */
export function attachVideoSync(anim, { videosEl, speedWarningEl } = {}) {
  anim.videos = null;
  const active = () => anim.videos?.length > 0 && anim.speed === 1;

  const origOnFrame = anim.onFrame;
  anim.onFrame = (t, ...rest) => {
    origOnFrame?.(t, ...rest);
    if (active()) syncVideos(anim.videos, t, anim.playing);
  };

  const origSeek = anim.seekTo.bind(anim);
  anim.seekTo = (t) => {
    origSeek(t);
    if (active()) syncVideos(anim.videos, anim.t, false);
  };

  const origPlay = anim.play.bind(anim);
  anim.play = () => {
    origPlay();
    if (active()) playVideos(anim.videos, anim.t);
  };

  const origPause = anim.pause.bind(anim);
  anim.pause = () => {
    origPause();
    pauseVideos(anim.videos);
  };

  const origSetSpeed = anim.setSpeed.bind(anim);
  anim.setSpeed = (s) => {
    origSetSpeed(s);
    const has = anim.videos?.length > 0;
    if (speedWarningEl) speedWarningEl.hidden = anim.speed === 1 || !has;
    if (!has) return;
    if (anim.speed === 1) {
      syncVideos(anim.videos, anim.t, false);
      if (anim.playing) playVideos(anim.videos, anim.t);
    } else {
      pauseVideos(anim.videos);
    }
  };

  return function setVideos(infos) {
    anim.videos = infos ?? null;
    const has = infos?.length > 0;
    if (videosEl) videosEl.hidden = !has;
    if (speedWarningEl) speedWarningEl.hidden = anim.speed === 1 || !has;
  };
}

/**
 * High-level helper: discover videos under `base`, mount them behind the
 * password gate, and wire them into `anim`.
 *
 * @param {object} anim - Animation instance.
 * @param {object} opts
 * @param {string} opts.base            - Raw asset HTTPS base URL.
 * @param {number|null} [opts.t0]       - Reference clock at session t=0.
 * @param {HTMLElement} opts.videosEl   - #videos wrapper.
 * @param {HTMLElement} opts.videosRow  - Mount point for the video tiles.
 * @param {HTMLElement} [opts.speedWarningEl]
 * @param {string[]} [opts.cameras]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<void>}
 */
export async function mountVideos(anim, {
  base, t0 = null, videosEl, videosRow, speedWarningEl, cameras, signal,
} = {}) {
  const setVideos = attachVideoSync(anim, { videosEl, speedWarningEl });
  if (!base) return;

  const found = await loadCameraVideos(base, { cameras, signal });
  if (signal?.aborted || !found.length) return;

  videosRow.innerHTML = '';
  videosRow.appendChild(withVideoGate(() => {
    const panel = document.createElement('div');
    panel.className = 'pb-videos-panel';
    const infos = buildVideoPanel(panel, found, t0);
    setVideos(infos);
    return panel;
  }));
  if (videosEl) videosEl.hidden = false;
}
