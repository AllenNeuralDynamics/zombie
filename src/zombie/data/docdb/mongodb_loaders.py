from datetime import datetime
from pathlib import Path
from typing import Optional
import pandas as pd
from aind_data_access_api.document_db import MetadataDbClient

from zombie.paths import DATA_PATH


client = MetadataDbClient(
    host="api.allenneuraldynamics.org",
    version="v2",
)


def metadata_qc_value_loader(asset_name: str) -> Optional[Path]:
    """Save to disk a parquet file containing the QC values for all metrics in an asset

    Metric names will be columns, we'll also include the subject_id and timestamp required columns
    """

    # Check if we already have a cached copy of this asset
    qc_filepath = DATA_PATH / f"qc-metrics_{asset_name}.pqt"

    if qc_filepath.exists():
        print(f"QC metrics file already exists at {qc_filepath}, skipping load.")

    else:
        records = client.retrieve_docdb_records(
            filter_query={
                "name": asset_name,
            },
            projection={
                "quality_control": 1,
                "subject.subject_id": 1,
                "acquisition.acquisition_start_time": 1,
            },
        )
        record = records[0]
        subject_id = record["subject"]["subject_id"]
        acquisition_time = datetime.fromisoformat(record["acquisition"]["acquisition_start_time"]).timestamp()

        # Split metrics by object type, "QC metric" or "Curation metric"
        if (
            "quality_control" not in record
            or not record["quality_control"]
            or "metrics" not in record["quality_control"]
        ):
            return None

        metrics = record["quality_control"]["metrics"]

        if len(metrics) == 0:
            return None

        qc_metrics = [metric for metric in metrics if metric["object_type"] == "QC metric"]
        # curation_metrics = [metric for metric in metrics if metric["object_type"] == "Curation metric"]

        qc_df = pd.DataFrame(qc_metrics)
        # Add a column with the subject_id, and a column with the acquisition as a timestamp
        qc_df["subject_id"] = subject_id
        qc_df["ts"] = acquisition_time

        qc_df["value"] = qc_df["value"].astype(str)
        qc_df.to_parquet(qc_filepath)

        # curation_filepath = output_dir / f"{asset_name}_curation_metrics.pqt"
        # pd.DataFrame(curation_metrics).to_parquet(curation_filepath)

    return qc_filepath
