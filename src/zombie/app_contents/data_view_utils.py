"""Utility functions for DataView data loading and S3 operations"""

import boto3
from botocore.exceptions import ClientError
import duckdb
import panel as pn

from zombie_squirrel.acorns import ACORN_REGISTRY


def get_s3_paths_for_data_type(data_type, subject_ids, asset_names):
    """
    Get S3 paths from loader function based on data type.
    
    Args:
        data_type: Type of data (e.g., 'qc', 'quality_control')
        subject_ids: List of subject IDs
        asset_names: List of asset names
        
    Returns:
        List of S3 paths or single string path
    """
    if data_type not in ACORN_REGISTRY:
        raise ValueError(f"Data type '{data_type}' not in ACORN_REGISTRY")
    
    loader_func = ACORN_REGISTRY[data_type]
    print(f"[DATA_VIEW_UTILS] Calling loader with lazy=True: {loader_func}")
    
    if data_type in ['qc', 'quality_control']:
        s3_paths = []
        for subject_id in subject_ids:
            if subject_id is None:
                continue
            path = loader_func(subject_id, asset_names, lazy=True)
            if isinstance(path, list):
                s3_paths.extend(path)
            elif path:
                s3_paths.append(path)
        print(f"[DATA_VIEW_UTILS] Got {len(s3_paths)} S3 paths from {len([s for s in subject_ids if s])} subjects")
        return s3_paths
    else:
        raise NotImplementedError(f"Data type '{data_type}' is not currently supported.")


def filter_existing_s3_files(s3_paths, max_paths=None):
    """
    Check which S3 files actually exist and return only existing ones.
    
    Args:
        s3_paths: List of S3 paths or single string
        max_paths: Optional limit on number of paths to check
        
    Returns:
        List of existing S3 paths
    """
    s3_client = boto3.client('s3')
    existing_paths = []
    
    paths_to_check = s3_paths if isinstance(s3_paths, list) else [s3_paths]
    if max_paths:
        paths_to_check = paths_to_check[:max_paths]
    
    for path in paths_to_check:
        if path.startswith('s3://'):
            bucket_key = path.replace('s3://', '')
            bucket = bucket_key.split('/')[0]
            key = '/'.join(bucket_key.split('/')[1:])
            
            try:
                s3_client.head_object(Bucket=bucket, Key=key)
                existing_paths.append(path)
                print(f"[DATA_VIEW_UTILS] ✓ Found: {path}")
            except ClientError as e:
                if e.response['Error']['Code'] == '404':
                    print(f"[DATA_VIEW_UTILS] ✗ Missing: {path}")
                else:
                    print(f"[DATA_VIEW_UTILS] ⚠ Error checking {path}: {e}")
        else:
            existing_paths.append(path)
            print(f"[DATA_VIEW_UTILS] Assuming exists (not S3): {path}")
    
    print(f"[DATA_VIEW_UTILS] Found {len(existing_paths)}/{len(paths_to_check)} existing files")
    return existing_paths


def build_duckdb_query(s3_paths, select_clause="*", where_clause=None):
    """
    Build a duckdb SQL query for reading parquet files.
    
    Args:
        s3_paths: List of S3 paths or single string
        select_clause: SQL SELECT clause (default "*")
        where_clause: Optional SQL WHERE clause
        
    Returns:
        Tuple of (query_string, from_clause)
    """
    if isinstance(s3_paths, str):
        from_clause = f"read_parquet('{s3_paths}', union_by_name=True)"
    elif isinstance(s3_paths, list):
        if not s3_paths:
            raise ValueError("Empty s3_paths list")
        parquet_list = "', '".join(s3_paths)
        from_clause = f"read_parquet(['{parquet_list}'], union_by_name=True)"
    else:
        raise TypeError(f"Unexpected s3_paths type: {type(s3_paths)}")
    
    where_part = f" WHERE {where_clause}" if where_clause else ""
    query = f"SELECT {select_clause} FROM {from_clause}{where_part}"
    
    return query, from_clause


@pn.cache
def load_dataframe_from_s3(data_type, subject_ids_tuple, asset_names_tuple):
    """
    Load full dataframe from S3 using duckdb.
    
    Args:
        data_type: Type of data to load
        subject_ids_tuple: Tuple of subject IDs (must be tuple for caching)
        asset_names_tuple: Tuple of asset names (must be tuple for caching)
        
    Returns:
        pandas DataFrame or None on error
    """
    subject_ids = list(subject_ids_tuple)
    asset_names = list(asset_names_tuple)
    
    try:
        s3_paths = get_s3_paths_for_data_type(data_type, subject_ids, asset_names)
        
        if not s3_paths:
            print(f"[DATA_VIEW_UTILS] ❌ No S3 paths returned")
            return None
        
        existing_paths = filter_existing_s3_files(s3_paths)
        
        if not existing_paths:
            print(f"[DATA_VIEW_UTILS] ❌ No existing files found")
            return None
        
        query, from_clause = build_duckdb_query(existing_paths, select_clause="*")
        print(f"[DATA_VIEW_UTILS] Executing SQL:\n{query}")
        
        conn = duckdb.connect()
        df = conn.execute(query).df()
        conn.close()
        
        print(f"[DATA_VIEW_UTILS] Loaded full dataframe: shape={df.shape}, columns={list(df.columns)}")
        return df
        
    except Exception as e:
        print(f"[DATA_VIEW_UTILS] ❌ Error loading data: {e}")
        import traceback
        traceback.print_exc()
        return None


@pn.cache
def get_unique_column_values(data_type, subject_ids_tuple, asset_names_tuple, column_name, limit=100, max_files=10):
    """
    Get unique values for a column from S3 parquet files.
    
    Args:
        data_type: Type of data to load
        subject_ids_tuple: Tuple of subject IDs (must be tuple for caching)
        asset_names_tuple: Tuple of asset names (must be tuple for caching)
        column_name: Name of column to get unique values for
        limit: Maximum number of unique values to return
        max_files: Maximum number of files to query
        
    Returns:
        List of unique values (as strings) or empty list on error
    """
    subject_ids = list(subject_ids_tuple)
    asset_names = list(asset_names_tuple)
    
    try:
        s3_paths = get_s3_paths_for_data_type(data_type, subject_ids, asset_names)
        
        if not s3_paths:
            return []
        
        existing_paths = filter_existing_s3_files(s3_paths, max_paths=max_files)
        
        if not existing_paths:
            print(f"[DATA_VIEW_UTILS] No existing files found for unique values")
            return []
        
        where_clause = f"{column_name} IS NOT NULL LIMIT {limit}"
        query, _ = build_duckdb_query(existing_paths, select_clause=f"DISTINCT {column_name}", where_clause=where_clause)
        print(f"[DATA_VIEW_UTILS] Query for unique values: {query}")
        
        conn = duckdb.connect()
        result = conn.execute(query).fetchall()
        conn.close()
        
        unique_values = sorted([str(row[0]) for row in result])
        print(f"[DATA_VIEW_UTILS] Found {len(unique_values)} unique values")
        return unique_values
        
    except Exception as e:
        print(f"[DATA_VIEW_UTILS] Error loading unique values: {e}")
        import traceback
        traceback.print_exc()
        return []
