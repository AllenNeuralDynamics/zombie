"""
Timing script for fiber photometry load pipeline.
Run with:  ../.venv/bin/python fib_timing.py
"""

import time
import duckdb

FIB_S3 = "s3://allen-data-views/data-asset-cache/zs_platform_fib.pqt"
BASICS_S3 = "s3://allen-data-views/data-asset-cache/zs_asset_basics.pqt"

def fmt(ms):
    return f"{ms:>8.0f} ms"

def pivot_long_form(rows):
    """Python mirror of pivotLongFormRows() in view.js."""
    import re

    def norm_channel(ch):
        m = re.match(r'^Fiber[ _](\d+)[ _](\w+)$', str(ch), re.IGNORECASE)
        if not m: return None
        color = m.group(2).capitalize()
        return f"Fiber_{m.group(1)}/{color}"

    def norm_fiber_index(f):
        m = re.match(r'^Fiber[ _](\d+)$', str(f), re.IGNORECASE)
        return m.group(1) if m else None

    BASICS = ['subject_id', 'project_name', 'acquisition_start_time',
              'data_level', 'modalities', 'genotype', 'location',
              'code_ocean', 'experimenters']

    asset_map = {}
    for row in rows:
        name = row['asset_name']
        if name not in asset_map:
            wide = {'asset_name': name}
            for k in BASICS:
                wide[k] = row.get(k)
            asset_map[name] = wide
        wide = asset_map[name]

        idx = norm_fiber_index(row.get('fiber', ''))
        if idx is not None:
            col = f"Fiber_{idx}/Target"
            ts = row.get('targeted_structure')
            if wide.get(col) in (None, ''):
                wide[col] = '' if (ts in ('missing', None)) else ts

        col = norm_channel(row.get('channel', ''))
        if not col: continue
        val = row.get('intended_measurement')
        if wide.get(col) in (None, ''):
            wide[col] = '' if (val in ('missing', None)) else val

    # Build Fiber_N/Channels summaries
    import re as re2
    for wide in asset_map.values():
        fiber_channels = {}
        for k, v in list(wide.items()):
            m = re2.match(r'^Fiber_(\d+)/([^T]\w*)$', k)
            if not m or not v: continue
            idx = m.group(1)
            fiber_channels.setdefault(idx, []).append((m.group(2), v))
        for idx, pairs in fiber_channels.items():
            pairs.sort(key=lambda x: x[0])
            wide[f"Fiber_{idx}/Channels"] = '\n'.join(f"{c}: {meas}" for c, meas in pairs)

    return list(asset_map.values())

def build_missing_table(wide_rows):
    """Python mirror of buildMissingTable() in view.js."""
    import re
    subject_map = {}
    for row in wide_rows:
        sid = row.get('subject_id', '')
        problems = []

        fiber_keys = {}
        for k, v in row.items():
            if not k.startswith('Fiber_'): continue
            if k.endswith('/Channels'): continue
            m = re.match(r'^Fiber_(\d+)/', k)
            if not m: continue
            fiber_keys.setdefault(m.group(1), []).append((k, v))

        for pairs in fiber_keys.values():
            if not any(v not in (None, '') for _, v in pairs):
                continue
            for k, v in pairs:
                if v in (None, ''):
                    suffix = 'no targeted structure' if k.endswith('/Target') else 'no intended measurement'
                    problems.append(f"{k}: {suffix}")

        if not problems: continue
        if sid not in subject_map:
            subject_map[sid] = {'investigators': set(), 'asset_count': 0, 'problems': set()}
        e = subject_map[sid]
        e['asset_count'] += 1
        e['problems'].update(problems)
        for exp in str(row.get('experimenters', '')).split(','):
            exp = exp.strip()
            if exp: e['investigators'].add(exp)

    return subject_map

# ---- Phase 1: download + parse parquet files --------------------------------
print("=" * 60)
print("Fiber Photometry load pipeline — timing breakdown")
print("=" * 60)

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs;")
con.execute("SET s3_region='us-west-2';")

t0 = time.perf_counter()
print(f"\nPhase 1a: CREATE TABLE platform_fib (download + parse fib parquet)")
con.execute(f"CREATE OR REPLACE TABLE platform_fib AS SELECT * FROM read_parquet('{FIB_S3}')")
t1 = time.perf_counter()
print(f"          {fmt((t1-t0)*1000)}  [{con.execute('SELECT COUNT(*) FROM platform_fib').fetchone()[0]:,} rows]")

print(f"\nPhase 1b: CREATE TABLE asset_basics (download + parse basics parquet)")
con.execute(f"CREATE OR REPLACE TABLE asset_basics AS SELECT * FROM read_parquet('{BASICS_S3}')")
t2 = time.perf_counter()
print(f"          {fmt((t2-t1)*1000)}  [{con.execute('SELECT COUNT(*) FROM asset_basics').fetchone()[0]:,} rows]")

# ---- Phase 2: JOIN query ----------------------------------------------------
print(f"\nPhase 2:  JOIN query (platform_fib LEFT JOIN asset_basics)")
t3 = time.perf_counter()
rows = con.execute(
    """SELECT f.asset_name, f.fiber, f.channel, f.targeted_structure, f.intended_measurement,
              b.subject_id, b.project_name, b.acquisition_start_time,
              b.data_level, b.modalities, b.genotype, b.location,
              b.code_ocean, b.experimenters
       FROM platform_fib f
       LEFT JOIN asset_basics b ON b.name = f.asset_name
       ORDER BY b.acquisition_start_time DESC NULLS LAST, f.asset_name"""
).fetchall()
t4 = time.perf_counter()
# Convert to list-of-dicts (mirrors what the browser does with JSON result)
cols = ['asset_name','fiber','channel','targeted_structure','intended_measurement',
        'subject_id','project_name','acquisition_start_time',
        'data_level','modalities','genotype','location','code_ocean','experimenters']
long_rows = [dict(zip(cols, r)) for r in rows]
t5 = time.perf_counter()
print(f"          {fmt((t4-t3)*1000)}  SQL execution  [{len(long_rows):,} long rows]")
print(f"          {fmt((t5-t4)*1000)}  → dict conversion")

# ---- Phase 3: pivot ---------------------------------------------------------
print(f"\nPhase 3:  pivotLongFormRows() — long → wide")
t6 = time.perf_counter()
wide_rows = pivot_long_form(long_rows)
t7 = time.perf_counter()
print(f"          {fmt((t7-t6)*1000)}  [{len(wide_rows):,} wide rows]")

# ---- Phase 4: missing table -------------------------------------------------
print(f"\nPhase 4:  buildMissingTable() — detect incomplete fiber info")
t8 = time.perf_counter()
missing = build_missing_table(wide_rows)
t9 = time.perf_counter()
print(f"          {fmt((t9-t8)*1000)}  [{len(missing):,} subjects with issues]")

# ---- Summary ----------------------------------------------------------------
total = (t9 - t0) * 1000
print(f"\n{'─'*60}")
print(f"  Total wall time: {fmt(total)}")
print(f"  Breakdown:")
print(f"    Download fib parquet:     {fmt((t1-t0)*1000)}  ({(t1-t0)/(t9-t0)*100:.0f}%)")
print(f"    Download basics parquet:  {fmt((t2-t1)*1000)}  ({(t2-t1)/(t9-t0)*100:.0f}%)")
print(f"    JOIN SQL:                 {fmt((t4-t3)*1000)}  ({(t4-t3)/(t9-t0)*100:.0f}%)")
print(f"    Dict conversion:          {fmt((t5-t4)*1000)}  ({(t5-t4)/(t9-t0)*100:.0f}%)")
print(f"    Pivot long→wide:          {fmt((t7-t6)*1000)}  ({(t7-t6)/(t9-t0)*100:.0f}%)")
print(f"    Missing table:            {fmt((t9-t8)*1000)}  ({(t9-t8)/(t9-t0)*100:.0f}%)")
print(f"{'─'*60}")

# ---- Bonus: quick look at the data -----------------------------------------
print(f"\nBonus info:")
print(f"  Unique assets:    {len(set(r['asset_name'] for r in long_rows)):,}")
print(f"  Unique channels:  {len(set(r['channel'] for r in long_rows if r['channel'])):,}")
print(f"  Sample channels:  {sorted(set(r['channel'] for r in long_rows if r['channel']))[:8]}")
con.close()
