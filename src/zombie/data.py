import boto3
import os
from botocore.exceptions import ClientError

# Test file to use
bucket = "codeocean-s3datasetsbucket-1u41qdg42ur9"
prefix = "417d11c1-d4df-4f72-a84a-66753a503aeb/nwb/behavior_791691_2025-04-29_11-10-29.nwb/"
local_dir = 'behavior_791691_2025-04-29_11-10-29.nwb'

# Create the local directory if it doesn't exist
os.makedirs(local_dir, exist_ok=True)

# Download all files in the directory
s3 = boto3.client('s3')
paginator = s3.get_paginator('list_objects_v2')
page_iterator = paginator.paginate(Bucket=bucket, Prefix=prefix)

downloaded_files = 0
for page in page_iterator:
    if 'Contents' in page:
        for obj in page['Contents']:
            file_key = obj['Key']
            # Skip directories
            if file_key.endswith('/'):
                continue
                
            # Create the local path
            relative_path = file_key[len(prefix):]
            local_file_path = os.path.join(local_dir, relative_path)
            
            # Create directories if needed
            os.makedirs(os.path.dirname(os.path.abspath(local_file_path)), exist_ok=True)
            
            # Download the file
            s3.download_file(bucket, file_key, local_file_path)
            downloaded_files += 1
            print(f"Downloaded {file_key} to {local_file_path}")

if downloaded_files == 0:
    print(f"No files found in {prefix}")
else:
    print(f"Downloaded {downloaded_files} files to {local_dir}")