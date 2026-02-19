from zombie_squirrel import asset_basics

project_name = "Learning mFISH-V1omFISH"

df = asset_basics()

print("=" * 80)
print(f"Total rows in asset_basics: {len(df)}")
print(f"Unique project names: {df['project_name'].unique()}")
print()

print("=" * 80)
print(f"Filtering for project: {project_name}")
filtered_df = df[df["project_name"] == project_name]
print(f"Found {len(filtered_df)} rows")
print()

if not filtered_df.empty:
    print("=" * 80)
    print("Acquisition times:")
    for idx, row in filtered_df.iterrows():
        start = row.get("acquisition_start_time")
        end = row.get("acquisition_end_time")
        name = row.get("name", "Unknown")
        print(f"  {name}")
        print(f"    Start: {start}")
        print(f"    End: {end}")
    print()
    
    print("=" * 80)
    times = []
    for _, row in filtered_df.iterrows():
        if row["acquisition_start_time"] and row["acquisition_end_time"]:
            times.append((row["acquisition_start_time"], row["acquisition_end_time"]))
    
    print(f"Valid time ranges: {len(times)}")
    if times:
        print(f"First time range: {times[0]}")
else:
    print("No data found for this project!")
    print()
    print("Available projects:")
    for pname in df['project_name'].unique()[:10]:
        print(f"  - {pname}")
