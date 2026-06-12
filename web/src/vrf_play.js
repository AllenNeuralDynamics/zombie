/**
 * vrf_play.js — entry point for the standalone VRF test page.
 *
 * Loads the hardcoded trial JSON for session 841314 / 2026-06-03, creates a
 * VrfAnimation on the canvas, and wires up all the playback controls + HUD.
 */

import * as Plot from '@observablehq/plot';
import { VrfAnimation, loadSprites, findSiteAt, mousePosAt } from './vr_foraging/animation.js';

const DATA_URL   = '/data/vrf_841314.json';
const SPRITE_URL = '/images/vrf';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const loadMsg = document.getElementById('vrf-loading');

  // Load in parallel
  loadMsg.textContent = 'Loading session data & sprites…';
  const [sites, sprites] = await Promise.all([
    fetch(DATA_URL).then((r) => r.json()),
    loadSprites(SPRITE_URL),
  ]);
  loadMsg.remove();

  // DOM refs
  const canvas    = document.getElementById('vrf-canvas');
  const statsEl   = document.getElementById('vrf-stats');
  const depEl     = document.getElementById('vrf-depletion');
  const stripEl   = document.getElementById('vrf-strip');
  const timeLbl   = document.getElementById('vrf-time');
  const playBtn   = document.getElementById('vrf-play');
  const scrubInput = document.getElementById('vrf-scrub');
  const speedSel  = document.getElementById('vrf-speed');

  // Pre-index reward sites by patch for fast depletion chart lookup
  const rewardSitesByPatch = buildPatchIndex(sites);

  // Create animation
  const anim = new VrfAnimation(canvas, sites, sprites);

  // ---- onFrame callback ---------------------------------------------------
  let lastSiteIdx = -1;

  anim.onFrame = (t, site) => {
    // Scrub bar
    scrubInput.value = (t / anim.duration) * 1000;

    // Time readout
    timeLbl.textContent = `${fmtTime(t)} / ${fmtTime(anim.duration)}`;

    // Stats
    const cumRew = anim.cumRewardsAt(site.site_index);
    const rp     = site.reward_probability;
    const rpStr  = rp != null ? `${(rp * 100).toFixed(1)}%` : '–';
    const state  = site.site_label === 'RewardSite'
      ? (site.has_choice
          ? (site.has_reward ? '✓ reward' : '✗ no reward')
          : 'upcoming')
      : site.site_label;

    statsEl.innerHTML =
      `<b>Patch ${site.patch_index + 1}/54</b> · ${site.patch_label} · ` +
      `site ${site.site_in_patch_index + 1}<br>` +
      `<span class="vrf-state">${state}</span> · P(rew) <b>${rpStr}</b> · ` +
      `rewards <b>${cumRew}/${anim.totalRewards}</b>`;

    // Depletion & strip (only on site change to avoid excessive redraws)
    if (site.site_index !== lastSiteIdx) {
      lastSiteIdx = site.site_index;
      updateDepletion(depEl, rewardSitesByPatch, site);
      updateStrip(stripEl, sites, site);
    }
  };

  // Initial render
  anim.draw();

  // ---- Controls -----------------------------------------------------------

  playBtn.addEventListener('click', () => togglePlay(anim, playBtn));

  scrubInput.addEventListener('input', () => {
    const t = (scrubInput.value / 1000) * anim.duration;
    lastSiteIdx = -1; // force depletion/strip update
    anim.seekTo(t);
  });

  speedSel.addEventListener('change', () => anim.setSpeed(Number(speedSel.value)));

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(anim, playBtn); }
    if (e.key === 'ArrowRight') jumpPatch(anim, sites, +1);
    if (e.key === 'ArrowLeft')  jumpPatch(anim, sites, -1);
    if (e.key === ',') anim.setSpeed(Math.max(1, anim.speed - 5));
    if (e.key === '.') anim.setSpeed(Math.min(60, anim.speed + 5));
  });

  // Auto-update play button icon while playing
  const origLoop = anim._loop.bind(anim);
  anim._loop = function (ts) {
    origLoop(ts);
    if (!anim.playing) playBtn.textContent = '▶';
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function togglePlay(anim, btn) {
  if (anim.playing) { anim.pause(); btn.textContent = '▶'; }
  else              { anim.play();  btn.textContent = '⏸'; }
}

function fmtTime(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/** Index of all RewardSite rows by patch_index. */
function buildPatchIndex(sites) {
  const m = new Map();
  for (const s of sites) {
    if (s.site_label !== 'RewardSite') continue;
    if (!m.has(s.patch_index)) m.set(s.patch_index, []);
    m.get(s.patch_index).push(s);
  }
  return m;
}

function odorColor(label) {
  if (label === 'odor_60') return '#ffb33a';
  if (label === 'odor_90') return '#3aaaff';
  return '#777788';
}

// ---------------------------------------------------------------------------
// Depletion bar (Observable Plot — tiny bar chart per patch)
// ---------------------------------------------------------------------------

function updateDepletion(el, patchIndex, currentSite) {
  const patchSites = patchIndex.get(currentSite.patch_index) ?? [];
  if (patchSites.length === 0) { el.replaceChildren(); return; }

  const color = odorColor(currentSite.patch_label);
  const chart = Plot.plot({
    width:        270,
    height:       80,
    marginLeft:   30,
    marginBottom: 20,
    marginTop:    6,
    marginRight:  4,
    style: { background: 'transparent', color: '#aaa', fontFamily: 'monospace', fontSize: 10 },
    x: { label: null, axis: null },
    y: { label: 'P', domain: [0, 1], ticks: [0, 0.5, 1] },
    marks: [
      Plot.barY(patchSites, {
        x: 'site_by_type_in_patch_index',
        y: (d) => d.reward_probability ?? 0,
        fill: (d) => {
          if (d.site_index === currentSite.site_index) return '#ffffff';
          if (d.start_time_s < currentSite.start_time_s) return '#333344';
          return color;
        },
        title: (d) =>
          `site ${d.site_by_type_in_patch_index + 1}: P=${((d.reward_probability ?? 0) * 100).toFixed(0)}%`,
      }),
    ],
  });
  el.replaceChildren(chart);
}

// ---------------------------------------------------------------------------
// Future-sites strip (dot-per-reward-site grid)
// ---------------------------------------------------------------------------

function updateStrip(el, sites, currentSite) {
  // Collect all reward sites, find window around current
  const rSites = sites.filter((s) => s.site_label === 'RewardSite');
  const curI   = rSites.findIndex((s) => s.site_index >= currentSite.site_index);
  const lo     = Math.max(0, curI - 4);
  const window = rSites.slice(lo, lo + 20);

  el.replaceChildren();
  for (const s of window) {
    const dot    = document.createElement('span');
    dot.className = 'vrf-dot';
    const isActive = s.site_index === currentSite.site_index;
    const isPast   = s.start_time_s < currentSite.start_time_s;
    const color    = odorColor(s.patch_label);

    Object.assign(dot.style, {
      background:  isPast && s.has_reward  ? color : 'transparent',
      borderColor: isPast && !s.has_reward ? '#333344' : color,
      opacity:     String(isActive ? 1 : isPast ? 0.45 : 0.85),
      outline:     isActive ? '2px solid #fff' : 'none',
      outlineOffset: '1px',
    });
    dot.title = `Patch ${s.patch_index + 1} · ${s.patch_label} · ` +
                `P=${((s.reward_probability ?? 0) * 100).toFixed(0)}%`;
    el.appendChild(dot);
  }
}

// ---------------------------------------------------------------------------
// Jump to prev / next patch
// ---------------------------------------------------------------------------

function jumpPatch(anim, sites, delta) {
  const cur         = findSiteAt(sites, anim.t);
  const targetPatch = Math.max(
    0,
    Math.min(sites[sites.length - 1].patch_index, cur.patch_index + delta),
  );
  const target = sites.find((s) => s.patch_index === targetPatch);
  if (!target) return;
  const wasPlaying = anim.playing;
  if (wasPlaying) anim.pause();
  anim.seekTo(target.start_time_s);
  if (wasPlaying) anim.play();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
main().catch((err) => {
  document.getElementById('vrf-loading').textContent = `Error: ${err.message}`;
  console.error(err);
});
