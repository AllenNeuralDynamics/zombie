/**
 * Measures how fast key data can be fetched directly from the NWB zarr
 * on S3 over HTTPS — no pre-caching.
 *
 * Run: node testing/nwb_fetch_speed.mjs
 */

const BASE = 'https://aind-open-data.s3.amazonaws.com/' +
  '841314_2026-06-03_12-38-21_processed_2026-06-09_02-27-52/behavior.nwb.zarr';

async function fetchBytes(url) {
  const t0 = performance.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = await r.arrayBuffer();
  const ms = performance.now() - t0;
  return { ms: Math.round(ms), bytes: buf.byteLength, buf };
}

async function fetchJson(url) {
  const t0 = performance.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const data = await r.json();
  const ms = performance.now() - t0;
  return { ms: Math.round(ms), data };
}

function kb(b) { return (b / 1024).toFixed(1) + ' KB'; }
function fmt(ms) { return ms >= 1000 ? (ms/1000).toFixed(2) + ' s' : ms + ' ms'; }

// Decode .zarray to find chunk shape
async function getZarray(path) {
  const { data } = await fetchJson(`${BASE}/${path}/.zarray`);
  return data;
}

// Fetch all chunks of a zarr array (1-D assumed).
async function fetchAllChunks(path, label) {
  const meta = await getZarray(path);
  const { shape, chunks } = meta;
  const nChunks = Math.ceil(shape[0] / chunks[0]);
  console.log(`  ${label}: shape=${shape} chunks=${chunks} → ${nChunks} chunk(s)`);

  const t0 = performance.now();
  const results = await Promise.all(
    Array.from({ length: nChunks }, (_, i) => fetchBytes(`${BASE}/${path}/${i}`))
  );
  const totalMs = Math.round(performance.now() - t0);
  const totalBytes = results.reduce((s, r) => s + r.bytes, 0);
  console.log(`    ✓ fetched in ${fmt(totalMs)} — ${kb(totalBytes)} total (${nChunks} chunk(s) parallel)`);
  return { ms: totalMs, bytes: totalBytes };
}

async function main() {
  console.log('NWB zarr fetch-speed test');
  console.log(`Base: ${BASE}\n`);

  const totals = { ms: 0, bytes: 0 };

  // 1. Consolidated metadata (single JSON blob describing all arrays)
  console.log('1. Consolidated metadata (.zmetadata)');
  try {
    const r = await fetchJson(`${BASE}/.zmetadata`);
    console.log(`   ✓ ${fmt(r.ms)} — ${kb(JSON.stringify(r.data).length)}`);
    totals.ms += r.ms;
  } catch (e) {
    console.log('   ✗ not found (zarr v3 or no consolidated):', e.message);
  }

  // 2. Trial table — all useful columns (805 rows each, single chunk each)
  //    Fetched in parallel as a browser would do.
  console.log('\n2. Trial table (intervals/trials) — all columns, parallel fetch');
  const trialCols = [
    'start_time','stop_time','site_label','patch_label','patch_index',
    'site_index','site_in_patch_index','site_by_type_in_patch_index',
    'start_position','length','reward_probability','has_choice',
    'has_reward','reward_onset_time','reward_amount','choice_cue_time',
  ];
  {
    const t0 = performance.now();
    const results = await Promise.all(trialCols.map(col => {
      const path = `intervals/trials/${col}`;
      return fetchAllChunks(path, col).catch(e => { console.log(`  ✗ ${col}: ${e.message}`); return { ms:0, bytes:0 }; });
    }));
    const wallMs = Math.round(performance.now() - t0);
    const totalB = results.reduce((s,r)=>s+r.bytes,0);
    console.log(`  → Wall time (all parallel): ${fmt(wallMs)}  total: ${kb(totalB)}`);
    totals.ms += wallMs; totals.bytes += totalB;
  }

  // 3. Position encoder — 348k samples split into 8 chunks
  console.log('\n3. Position encoder (CurrentPosition) — 348k rows, 8 chunks each, parallel');
  const posArrays = [
    'acquisition/Behavior.OperationControl.CurrentPosition/Position',
    'acquisition/Behavior.OperationControl.CurrentPosition/Seconds',
  ];
  {
    const t0 = performance.now();
    const results = await Promise.all(posArrays.map(a =>
      fetchAllChunks(a, a.split('/').pop()).catch(e => { console.log(`  ✗ ${a}: ${e.message}`); return {ms:0,bytes:0}; })
    ));
    const wallMs = Math.round(performance.now() - t0);
    const totalB = results.reduce((s,r)=>s+r.bytes,0);
    console.log(`  → Wall time (both parallel): ${fmt(wallMs)}  total: ${kb(totalB)}`);
    totals.ms += wallMs; totals.bytes += totalB;
  }

  // 4. Lick state — 6077 rows, single chunk each
  console.log('\n4. Lick state (HarpLickometer.LickState) — 6077 rows, 1 chunk each, parallel');
  const lickArrays = [
    'acquisition/Behavior.HarpLickometer.LickState/Channel0',
    'acquisition/Behavior.HarpLickometer.LickState/Time',
  ];
  {
    const t0 = performance.now();
    const results = await Promise.all(lickArrays.map(a =>
      fetchAllChunks(a, a.split('/').pop()).catch(e => { console.log(`  ✗ ${a}: ${e.message}`); return {ms:0,bytes:0}; })
    ));
    const wallMs = Math.round(performance.now() - t0);
    const totalB = results.reduce((s,r)=>s+r.bytes,0);
    console.log(`  → Wall time (both parallel): ${fmt(wallMs)}  total: ${kb(totalB)}`);
    totals.ms += wallMs; totals.bytes += totalB;
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Total data transferred:  ${kb(totals.bytes)}`);
  console.log(`\nIf everything fetched in parallel (realistic browser load):`);
  console.log(`  Trial table (~16 cols × 4–8 KB ea): ~1 RTT + download, ~50–150 ms`);
  console.log(`  Position encoder (8 chunks × 348 KB): the dominant cost`);
  console.log(`  Lick state (2 × ~48 KB): negligible`);
  console.log(`  .zmetadata (1.5 MB): only needed if using consolidated zarr`);
  console.log(`\nConclusion: see above per-group wall times.`);
}

main().catch(console.error);
