---
name: zombie-specialized-viewers
description: Maintain Zombie's fiber, ecephys, pophys, behavior, and SWDB specialized viewers and their partitioned data access.
---

# Zombie specialized viewers

Use the existing adapters and playback components instead of creating new viewer transports. Fiber traces come from partitioned `platform_fib_traces` and operations from `platform_fib_operations`; `fib-playback.js` lists S3 partition objects before reading a selected asset/channel/time range because virtual-hosted S3 globbing is unreliable. Ecephys uses partitioned `platform_ecephys_spikes` and `platform_ecephys_units`, resolves raw-to-derived `source_data`, and reuses `ecephys-playback.js`, the raster, and MIDI controls. Pophys uses `platform_pophys` for contours/projections and the NWB-Zarr helpers in `pophys/cache.js` and `nwb-traces.js`.

The public VR viewer loads NWB data from `aind-open-data`. Dynamic-foraging and dynamic-routing viewers read their explicit parquet roots and reuse the existing animation, event-plot, and `playback-harness` transport. The SWDB pages are deliberately isolated under `web/src/swdb/`: both entries call `bootstrap(view, {requiredTables: []})`, `swdb/data.js` is the only cache URL builder, and every asset partition is selected explicitly after `assertAssetName()` validation. Apply SQL column pruning and decimation before materializing wide traces. `dr-session.js` shifts NWB session-clock times so the first trial is zero.

Keep abort checks around lazy reads and validate asset names before interpolating them into URLs or SQL. Test data adapters and decimators with fixtures; test viewer state with mocked fetch/coordinator calls. Do not move SWDB cache knowledge outside `web/src/swdb/`.
