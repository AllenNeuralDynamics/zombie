from zombie_squirrel import asset_basics
import pandas as pd

project_name = "Cognitive flexibility in patch foraging"

df = asset_basics()

print("=" * 80)
print("DataFrame columns:")
print(df.columns.tolist())
print()

print("=" * 80)
print(f"Filtering for project: {project_name}")
filtered_df = df[df["project_name"] == project_name]
print(f"Found {len(filtered_df)} rows")
print()

if not filtered_df.empty:
    print("=" * 80)
    print("First few rows:")
    print(filtered_df.head())
    print()
    
    print("=" * 80)
    print("Column data types:")
    print(filtered_df.dtypes)
    print()
    
    print("=" * 80)
    print("Acquisition start times:")
    print(filtered_df["acquisition_start_time"].tolist())
    print()
    
    print("=" * 80)
    print("Acquisition end times:")
    print(filtered_df["acquisition_end_time"].tolist())
    print()
    
    print("=" * 80)
    print("Modalities (first 3):")
    for idx, mod in enumerate(filtered_df["modalities"].head(3)):
        print(f"Row {idx}: {mod} (type: {type(mod)})")
    print()
    
    print("=" * 80)
    print("Testing time range extraction:")
    start_times = pd.to_datetime(filtered_df["acquisition_start_time"], errors='coerce')
    min_time = start_times.min()
    max_time = start_times.max()
    print(f"Min time: {min_time} (type: {type(min_time)})")
    print(f"Max time: {max_time} (type: {type(max_time)})")
    print()
    
    print("=" * 80)
    print("Testing session times extraction (NEW FORMAT):")
    times = []
    for idx, row in filtered_df.iterrows():
        start = row["acquisition_start_time"]
        end = row["acquisition_end_time"]
        if idx < 3:
            print(f"Row {idx}: start={start} (type: {type(start)}), end={end} (type: {type(end)})")
        if start and end:
            times.append((start, end))
    print(f"\nTotal valid times: {len(times)}")
    print(f"Times list (first 3): {times[:3]}")
    
    print("\n" + "=" * 80)
    print("Testing with pd.to_datetime (what time_view does):")
    import pandas as pd
    for i, (start, end) in enumerate(times[:3]):
        start_dt = pd.to_datetime(start)
        end_dt = pd.to_datetime(end)
        start_ms = start_dt.timestamp() * 1000
        end_ms = end_dt.timestamp() * 1000
        print(f"Session {i}: {start_dt} to {end_dt}")
        print(f"  Milliseconds: {start_ms} to {end_ms}")
else:
    print("No data found for this project!")
    print()
    print("Available projects:")
    print(df["project_name"].unique()[:20])
