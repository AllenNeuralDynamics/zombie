import pyarrow.parquet as pq
import boto3
import io
import json

S3_BUCKET = "allen-data-views"
S3_KEY = "data-asset-cache/zs_qc/833855.pqt"


def main():
    s3 = boto3.client("s3")
    buf = io.BytesIO()
    s3.download_fileobj(S3_BUCKET, S3_KEY, buf)
    buf.seek(0)

    pf = pq.ParquetFile(buf)
    schema = pf.schema_arrow

    print("=== Arrow schema ===")
    print(schema)

    print("\n=== First 5 rows (all columns) ===")
    table = pf.read_row_group(0)
    df = table.slice(0, 5).to_pydict()
    for col, vals in df.items():
        print(f"  {col}: {vals}")

    print("\n=== Timestamp-like columns detail ===")
    for i, field in enumerate(schema):
        t = str(field.type)
        if any(k in t.lower() for k in ("timestamp", "date", "time")):
            col = table.column(field.name)
            print(f"\n  Field: {field.name}")
            print(f"  Arrow type: {field.type}")
            print(f"  First 3 values (Python): {col.slice(0, 3).to_pylist()}")
            print(f"  First 3 values (cast to int64): {col.cast('int64').slice(0, 3).to_pylist()}")


if __name__ == "__main__":
    main()
