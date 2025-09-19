import s3fs
from hdmf_zarr import NWBZarrIO

# Load the NWB file directly from S3
bucket_path = 'aind-open-data/single-plane-ophys_731015_2025-01-10_18-06-31_processed_2025-08-03_20-39-09/'
nwb_file_path = 'single-plane-ophys_731015_2025-01-10_18-06-31_behavior_nwb'
full_s3_path = f's3://{bucket_path}{nwb_file_path}'

print(f"Loading NWB file from: {full_s3_path}")

# Load the NWB file using NWBZarrIO
io = NWBZarrIO(path=full_s3_path, mode='r', storage_options={'anon': True})
nwbfile_zarr = io.read()

print("Successfully loaded NWB file!")
print(f"Session description: {nwbfile_zarr.session_description}")
print(f"Identifier: {nwbfile_zarr.identifier}")
print(f"Session start time: {nwbfile_zarr.session_start_time}")