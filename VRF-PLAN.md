# VRF-PLAN — Pixel-art animation of a VR Foraging session

A top-down pixel-art animation of a mouse running a [VR Foraging](https://github.com/AllenNeuralDynamics/Aind.Behavior.VrForaging) session, yoked to the trial table of a real asset. Reference asset for this investigation:

```
s3://aind-open-data/841314_2026-06-03_12-38-21_processed_2026-06-09_02-27-52/
```

## TL;DR

- The trial table in `behavior.nwb.zarr/intervals/trials` is **everything we need** for the animation; we don't need the raw Harp time-series.
- The world is **1-D** (a linear VR corridor along `start_position` cm). "Mouse runs north" is just a vertical scroll of the world past a fixed mouse sprite at screen-centre.
- A new biodata-cache table `vrf_sites` (1 row per site, 805 rows for the example session) holds everything; a thin `vrf_sessions` table holds per-session roll-ups.
- Pixel-art sprites have already been generated and committed to [web/public/images/vrf](web/public/images/vrf).
- Estimated implementation: one new view module (`web/src/vr_foraging/animation.js`), one CSS section, one new cache table — no new framework dependencies.

---

## 1 · What the trial table actually contains

The asset is small (~3 MB of metadata; trial table is 805 rows). Loaded via `zarr.open_group(..., use_consolidated=False)` (zarr-v3 chokes on this NWB's consolidated metadata block, but per-array access works fine).

The "trials" table is **per-site**, not per-decision. Each row is one of three site types that the mouse traverses sequentially as it runs down the linear corridor:

| `site_label`  | Meaning                                                    | Typical `length` |
| ------------- | ---------------------------------------------------------- | ---------------- |
| `InterPatch`  | Long empty corridor between patches                        | ~200 – 600 cm    |
| `InterSite`   | Short corridor between two reward sites inside one patch   | ~20 – 90 cm      |
| `RewardSite`  | The actual odor zone — fixed length, mouse can stop & lick | exactly 50 cm    |

Sites flow in a strict pattern within each patch:

```
InterPatch → InterSite → RewardSite → InterSite → RewardSite → … → next InterPatch
```

### Key per-row fields used by the animation

| Field                            | Type      | Description                                                                       |
| -------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `start_time`, `stop_time`        | float (s) | Harp clock; subtract `start_time.min()` for a session-relative timeline.          |
| `start_position`, `length`       | float (cm)| Position along the 1-D corridor. Monotonic across the session (max ≈ 489 m here). |
| `site_label`                     | str       | `InterPatch` / `InterSite` / `RewardSite`.                                        |
| `patch_label`                    | str       | Categorical odor identity. In this session: `odor_0`, `odor_60`, `odor_90`.       |
| `patch_index`, `block_index`     | int       | Patch and block IDs within the session.                                           |
| `site_in_patch_index`            | int       | 0-based site number inside its patch (mixes InterSite + RewardSite).              |
| `site_by_type_in_patch_index`    | int       | 0-based site number among the same type — for RewardSite this is the depletion step. |
| `odor_concentration`             | float[3]  | One-hot in this session: `(1,0,0)`, `(0,1,0)`, or `(0,0,1)` — three odor channels.|
| `odor_onset_time`                | float (s) | When the valve opened on entry; null on non-reward sites.                          |
| `reward_probability`             | float     | Reward probability at the time of the choice (already decremented by depletion).   |
| `has_choice`                     | bool      | Mouse stopped in the site → a decision was registered.                             |
| `choice_cue_time`                | float (s) | When the stop / decision happened.                                                 |
| `has_reward`                     | bool      | Reward actually delivered (subset of has_choice).                                  |
| `reward_onset_time`              | float (s) | Valve open time for the reward (null when no reward).                              |
| `reward_amount`                  | float     | Configured volume (µL); not necessarily what was delivered — pair with `has_reward`. |
| `reward_delay_duration`          | float (s) | `reward_onset_time − choice_cue_time`.                                             |
| `has_waited_reward_delay`        | bool      | Mouse waited long enough at the lick port to collect.                              |
| `reward_available`               | float     | Reward volume still in patch (sentinel `9999.0` here = effectively infinite).      |
| `friction`                       | float (%) | Treadmill friction at the site.                                                    |

### What the example session contains

- **Duration:** 53.0 min (`start_time` spans 3 177 s).
- **Sites:** 805 total → 54 `InterPatch` + 402 `InterSite` + **349 `RewardSite`**.
- **Patches:** 54 in 1 block.
- **Patch label mix:** `odor_90` (most common, also highest baseline reward prob), `odor_60` (medium), `odor_0` (control — mouse never licks; 1 reward site per patch, 0 choices).
- **Decisions:** 296 stops; 147 rewards delivered.
- **Depletion demonstration** (patch 0, `odor_60`):
  `0.60 → 0.528 → 0.464 → 0.408 → 0.359 → 0.359 → 0.359 → 0.359 → 0.316 → 0.316 → 0.316 → 0.278 → …`
  → depletion steps down with the number of *consecutive successful licks*, not raw site count (which matches the underlying Beta-distribution depletion model in the task).

---

## 2 · What's possible and what isn't from the trial table alone

### Possible (this plan implements all of them)

- Smooth top-down scrolling world keyed to real timestamps.
- Distinct visual blocks for `InterPatch` (dark void) and patches (lit ground).
- Discrete odor-site markers, coloured by `patch_label` / `odor_concentration`.
- Run-cycle animation while the mouse is moving; idle/lick pose when stopped.
- Lick-burst sparkle at `choice_cue_time`; reward drop pop at `reward_onset_time` when `has_reward=true`.
- Live HUD: patch # / site # / cumulative rewards / current reward probability / running foraging efficiency.
- Per-patch depletion bar (sub-window in the corner showing the next-N reward probabilities as a bar chart).
- A scrubbable timeline at the bottom that maps to `start_time → stop_time`.
- Playback speed control (default 10×) since 53 min real time would be tedious to watch.

### Not possible from the trial table alone

- **Continuous mouse velocity & licking trace.** The trial table only has start/stop and choice/onset events — not per-lick timestamps or per-sample wheel velocity. The animation **interpolates** position linearly inside each site, which is plausible (≈25 cm/s average) but not literally true (the mouse decelerates into a stop, sits for ~2 s, accelerates out).
  - If we ever want true velocity, it's in `acquisition/Behavior.HarpBehavior.AnalogData/Encoder` (treadmill encoder), and licks are in `acquisition/Behavior.HarpLickometer.LickState`. Out of scope for v1 — too much data, no cache table for it yet.
- **Camera / video frames.** Cameras 0/1 are recorded but not in the cache pipeline; we never want to ship video.
- **"Turning"** when the mouse exits a patch. The corridor is genuinely 1-D, the mouse never turns. We can fake a small camera-shake / fade-to-void transition for visual flair, but no real turn-to-next-patch motion exists.

---

## 3 · Animation design

### Layout (1080×360 inside the platform page)

```
┌───────────────────────────────────────────────────────────────────────┐
│  Patch 12/54 · odor_90  ·  Site 5/7  ·  Reward 67/147  ·  η = 0.71   │ ← HUD
├──────────────────────┬────────────────────────────────────────────────┤
│                      │ ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌ │
│                      │ depletion bar for current patch                │
│                      ├────────────────────────────────────────────────┤
│  [scrolling          │ ▼ current site                                 │
│   world canvas]      │                                                │
│      mouse           │  ⬤  ⬤  ⬤  ⬤  ⬤  ◯  ◯  ◯  ◯  ◯  ◯              │
│      fixed at        │  past rewards ↑          ↑ future sites        │
│      centre          │                                                │
│                      ├────────────────────────────────────────────────┤
│                      │ [▶ ⏸  ] speed 10× ━━━━━●━━━━━━━━━  00:23 / 53:00 │
└──────────────────────┴────────────────────────────────────────────────┘
```

The main canvas is the **world panel** (left ~⅔ width). The right column is a **HUD/dashboard** (depletion, future-sites strip, transport controls).

### World rendering

- Single `<canvas>` element, **width 200 logical px × height 360 logical px**, then upscaled with `image-rendering: pixelated` to whatever the layout gives us. Keeps the pixel-art feel and is dirt-cheap to draw (~72 000 logical pixels).
- The mouse sprite stays pinned at, say, y = 256 (near bottom). The world scrolls **upward** (north) past it. `worldY = scrollY − mousePosCm * PX_PER_CM`.
- `PX_PER_CM ≈ 1.0` so a 50 cm reward site is ~50 px tall, a 400 cm InterPatch is one whole screen tall.
- Background = `void_tile` repeated. Inside an `InterPatch` segment, draw the void. Inside a patch segment (`InterSite` + `RewardSite` rows), tile `patch_tile`.
- For each `RewardSite`, draw the `odor_swirl_{60,90,0}.svg` sprite centred on the site, with the swirl tinted per `patch_label`. Add a faint glow halo whose alpha = `reward_probability` (so depleted sites visibly fade).

### Mouse animation

- **State machine** with four states: `running`, `stopping`, `licking`, `leaving`.
- `running` → cycle frames `mouse_run_a` ↔ `mouse_run_b` every ~120 ms (visual cadence; not yoked to actual stride frequency).
- `stopping` → swap to `mouse_idle` for a short pre-choice window (~0.3 s).
- `licking` → swap to `mouse_lick` for the choice window. Spawn a `lick_burst` sprite at the nose for 100 ms each lick beat (3–5 beats inside `reward_delay_duration`).
- After `reward_onset_time` if `has_reward`, spawn a `reward_drop` sprite that rises from the nose and dissolves.
- `leaving` → back to `mouse_run_*` cycle; small "puff" particle would be nice but isn't strictly needed.

### Time mapping

Each site row gives us `[start_time, stop_time]` and `[start_position, start_position+length]`. For a given session wall-clock `t`, find the active site (binary search on `start_time`), then:

```js
const frac = (t - site.start_time) / (site.stop_time - site.start_time);
let pos = site.start_position + frac * site.length;
```

Override this for stop events: when `choice_cue_time` is in `[start_time, stop_time]`, hold position at `start_position + 0.5 * length` (centre of the reward site) for the window `[choice_cue_time, choice_cue_time + reward_delay_duration + 0.4]` — that's the "stopped & licking" window.

Playback speed is just `t = realtime * speedMultiplier`; `speedMultiplier` defaults to 10×, slider goes from 1× to 60×. Pause/play/scrub all operate on `t`.

### HUD

- **Future-sites strip** — vertical column of dots, top = far ahead, bottom = current site. Filled discs for past RewardSites coloured by `has_reward`; outlined discs for upcoming. Scrolls down with playback.
- **Depletion bar** — small horizontal bar chart of `reward_probability` for every RewardSite in the *current* patch, with the active one highlighted. Trivial Observable Plot call (≤ 30 bars).
- **Counters** — patch index, site index in patch, cumulative rewards, cumulative volume (`5 µL × has_reward.sum()`), running foraging efficiency.

### Controls

- Subject + session selector at the top of the page (existing `asset_basics` query, filtered to `acquisition_type = 'AindVrForaging'`).
- Play / pause button, speed slider, scrub-bar with mm:ss readout.
- Keyboard: `space` = play/pause, `←/→` = jump ±1 patch (handy for QA), `,/.` = ±0.5× speed.

---

## 4 · Biodata-cache table schema

Mirrors the existing `foraging_sessions` acorn pattern (see [web/src/lib/behaviors/foraging-metadata.js](web/src/lib/behaviors/foraging-metadata.js)). Two tables published as parquet by `biodata-cache` and registered as DuckDB tables via `cache_registry.json`.

### `vrf_sessions` — one row per asset (≈ 1 KB / row)

Used for the page's session selector and to gate the heavier query on `vrf_sites`.

| Column                    | Type      | Source                                                  |
| ------------------------- | --------- | ------------------------------------------------------- |
| `name`                    | varchar   | `asset_basics.name` (join key)                          |
| `subject_id`              | varchar   |                                                         |
| `session_date`            | date      | derived from `acquisition_start_time`                   |
| `session_duration_s`      | double    | `max(stop_time) - min(start_time)`                      |
| `n_patches`               | integer   | `max(patch_index) + 1`                                  |
| `n_blocks`                | integer   | `max(block_index) + 1`                                  |
| `n_reward_sites`          | integer   | `count(site_label = 'RewardSite')`                      |
| `n_choices`               | integer   | `sum(has_choice)`                                       |
| `n_rewards`               | integer   | `sum(has_reward)`                                       |
| `total_reward_volume_ul`  | double    | `sum(reward_amount * has_reward)` (assuming µL)         |
| `foraging_efficiency`     | double    | computed; or NULL if not derivable from trials alone    |
| `patch_labels`            | varchar[] | distinct `patch_label` values                           |
| `corridor_length_cm`      | double    | `max(start_position) + last_site_length`                |
| `nwb_zarr_path`           | varchar   | S3 URI to the source zarr (so we can deep-link)         |

### `vrf_sites` — one row per site (≈ 800 rows × ≈ 100 B = 80 KB per session, raw)

This is essentially a flattened copy of `intervals/trials`. With ~600 cached sessions × ~800 rows each ≈ 500 K rows total — small parquet, easy.

| Column                          | Type         | Notes                                              |
| ------------------------------- | ------------ | -------------------------------------------------- |
| `name`                          | varchar      | FK to `vrf_sessions.name` and `asset_basics.name`. |
| `site_index`                    | integer      | Primary ordering within a session.                 |
| `block_index`                   | integer      |                                                    |
| `patch_index`                   | integer      |                                                    |
| `patch_in_block_index`          | integer      |                                                    |
| `site_in_patch_index`           | integer      |                                                    |
| `site_by_type_in_patch_index`   | integer      | Depletion step number for RewardSite rows.          |
| `site_label`                    | varchar      | `InterPatch` / `InterSite` / `RewardSite`.         |
| `patch_label`                   | varchar      | Categorical odor identity.                         |
| `start_time_s`                  | double       | Use *session-relative* time: subtract `min(start_time)` before caching, so the player doesn't have to. Store the offset in `vrf_sessions.session_t0`. |
| `stop_time_s`                   | double       |                                                    |
| `start_position_cm`             | double       |                                                    |
| `length_cm`                     | double       |                                                    |
| `friction_pct`                  | double       |                                                    |
| `odor_onset_time_s`             | double       | NULL on non-reward sites.                           |
| `odor_channel_0`                | double       | Unrolled from `odor_concentration[0..2]` — easier  |
| `odor_channel_1`                | double       | than handling list columns in DuckDB.              |
| `odor_channel_2`                | double       |                                                    |
| `reward_amount_ul`              | double       |                                                    |
| `reward_probability`            | double       |                                                    |
| `reward_available`              | double       |                                                    |
| `has_reward`                    | boolean      |                                                    |
| `choice_cue_time_s`             | double       |                                                    |
| `has_choice`                    | boolean      |                                                    |
| `reward_delay_duration_s`       | double       |                                                    |
| `has_waited_reward_delay`       | boolean      |                                                    |
| `reward_onset_time_s`           | double       |                                                    |

**Pre-bake decisions worth making in the cache builder**

1. **Subtract `start_time.min()`** so `start_time_s` is 0-based; saves a normalisation step in every query.
2. **Drop fully-empty sentinel rows.** A few tail rows in this session show `stop_time` slightly past the actual session end; clip them to a sane bound.
3. **Sentinel hygiene.** `reward_available = 9999.0` is "infinite"; replace with NULL so the chart doesn't blow up its y-axis.
4. **Sort by `(name, site_index)`** before writing parquet so a single-asset query reads one contiguous row-group.

**Sample queries the page would issue**

```sql
-- Session selector dropdown (cheap, joins on asset_basics)
SELECT s.name, s.subject_id, s.session_date,
       s.n_patches, s.n_rewards, s.session_duration_s
FROM   vrf_sessions s
JOIN   asset_basics a USING (name)
WHERE  a.acquisition_type = 'AindVrForaging'
ORDER  BY s.session_date DESC;

-- All sites for the selected session (≤ 1000 rows; <100 KB)
SELECT * FROM vrf_sites
WHERE  name = ?
ORDER  BY site_index;
```

---

## 5 · Implementation plan

### Files to add

| Path                                                | Purpose                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| [scripts/build_vrf_sprites.py](scripts/build_vrf_sprites.py)               | ✅ already added — regenerates SVG sprites from pixel grids.     |
| [web/public/images/vrf/*.svg](web/public/images/vrf)                       | ✅ already generated (11 sprites, ~90 KB total).                 |
| `web/src/vr_foraging/animation.js`                   | New view module: canvas renderer + state machine + HUD.          |
| `web/src/vr_foraging/data.js`                        | Query helpers: `loadSessionList()`, `loadSites(name)`, parsing.  |
| `web/src/vr_foraging/view.js`                        | **Modified** — add a "Session animation" subview above the existing platform overview. |
| `web/styles/app.css`                                 | Append `.vrf-animation`, `.vrf-canvas`, `.vrf-hud-*` rules.      |
| `web/src/__tests__/vrf-animation.test.js`            | Pure-function tests for the time→position interpolator and site-finder. |

Plus on the cache side (separate `biodata-cache` repo):

| Path / change                                       | Purpose                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `biodata_cache/builders/vrf_sites.py`                | Read `behavior.nwb.zarr/intervals/trials` per asset, flatten odor_concentration, normalise times, write parquet. |
| `biodata_cache/builders/vrf_sessions.py`             | Aggregate from `vrf_sites` → `vrf_sessions`.                     |
| `cache_registry.json` entries                        | Two new acorns: `vrf_sessions` (metadata), `vrf_sites` (metadata). |

### Suggested build order

1. **Cache builder** (Python, in `biodata-cache`): implement `vrf_sites.py` + `vrf_sessions.py` using the same zarr-without-consolidated-metadata trick this investigation used. Publish a draft acorn to the dev S3 prefix.
2. **`data.js`** + tests: registry/query layer, mirrors `foraging-metadata.js`.
3. **Static world rendering**: `animation.js` v0 — given a sites array, draw the world panel at `t=0` and let the user scrub with the slider. No mouse animation yet.
4. **Mouse + run cycle**: implement the state machine. Interpolation only; no lick burst / reward drop.
5. **Lick + reward events**, **HUD**, **future-sites strip**, **depletion bar**.
6. **Polish**: dark-theme support (the sprites are already mid-tone so they work on both), keyboard shortcuts, smooth scrubbing.

### Performance budget

- One redraw per `requestAnimationFrame` (~60 fps). Each frame: ≤ 200×360 = 72 000 pixels written; only visible tiles drawn; everything else is a small sprite blit. Trivial.
- Loading a session = one DuckDB SELECT returning ≤ 1 000 rows. The whole experience never re-queries during playback.

---

## 6 · Pixel-art assets (already generated)

Generated by [scripts/build_vrf_sprites.py](scripts/build_vrf_sprites.py) and written to [web/public/images/vrf](web/public/images/vrf). All sprites are tiny SVGs (1-px-per-`<rect>` grids on a fixed `viewBox`) so they upscale crisply at any size and dark-/light-theme don't need rebuilds.

| File              | Size  | What it is                                       |
| ----------------- | ----- | ------------------------------------------------ |
| `mouse_run_a.svg` | 16×16 | Run cycle frame A (forepaws splayed).            |
| `mouse_run_b.svg` | 16×16 | Run cycle frame B (hindlegs back).               |
| `mouse_idle.svg`  | 16×16 | Standing still pre-stop.                         |
| `mouse_lick.svg`  | 16×16 | Pink tongue extended north.                      |
| `reward_drop.svg` | 8×10  | Water drop popping up after a reward.            |
| `lick_burst.svg`  | 12×12 | Yellow radial sparkle at the choice moment.      |
| `odor_swirl_0.svg`  | 16×16 | Odor-marker ring, grey (control / no reward).  |
| `odor_swirl_60.svg` | 16×16 | Odor-marker ring, amber (`odor_60`).           |
| `odor_swirl_90.svg` | 16×16 | Odor-marker ring, azure (`odor_90`).           |
| `patch_tile.svg`  | 16×16 | Tileable lit-green patch ground.                 |
| `void_tile.svg`   | 16×16 | Tileable dark inter-patch void.                  |

To regenerate or iterate on the art, edit the string-art grids in [scripts/build_vrf_sprites.py](scripts/build_vrf_sprites.py) and rerun `.venv/bin/python scripts/build_vrf_sprites.py`.

---

## 7 · Open questions

1. **Mapping `patch_label` → colour.** I picked amber for `odor_60` and azure for `odor_90` arbitrarily. If there's an established colour convention from the lab (e.g. reflecting the literal odor chemistry), let me know and I'll swap.
Answer: the colors are fine for now
2. **µL or mL for reward.** `reward_amount` is `5.0` per row; almost certainly 5 µL (the standard VRF reward), but the column description doesn't disambiguate. I'll assume µL unless told otherwise.
Answer: Yes it's 5 microliters
3. **What sits next to the animation on the existing `/vr_foraging` platform page?** Options: (a) replace the current overview, (b) put it in a new collapsible card *above* the overview, (c) make it a separate `/vr_foraging/play` route. My default is (b).
Answer: Don't worry about implementing the animation on the page just make a standalone page for now
4. **How many sessions per page load?** I assume the user selects one session at a time. If we want a "compare two animations side-by-side" mode it's the same components × 2 — easy but not specced.
Answer: one session, but for testing we're going to use the exact session we worked with.