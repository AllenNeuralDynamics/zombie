
from pathlib import Path
import pandas as pd
from aind_data_access_api.document_db import MetadataDbClient

from zombie.paths import DATA_PATH


client = MetadataDbClient(
    host="api.allenneuraldynamics.org",
    version="v2",
)


def metadata_qc_loader(asset_name: str) -> Path:
    """Save to disk a parquet file containing the QC for a metric"""

    records = client.retrieve_docdb_records(
        filter_query={
            "name": asset_name,
        },
        projection={
            "quality_control": 1,
        }
    )
    record = records[0]

    # Split metrics by object type, "QC metric" or "Curation metric"
    metrics = record["quality_control"]["metrics"]
    qc_metrics = [metric for metric in metrics if metric["object_type"] == "QC metric"]
    # curation_metrics = [metric for metric in metrics if metric["object_type"] == "Curation metric"]

    qc_filepath = DATA_PATH / f"{asset_name}_qc_metrics.pqt"
    qc_df = pd.DataFrame(qc_metrics)
    qc_df['value'] = qc_df['value'].astype(str)
    qc_df.to_parquet(qc_filepath)

    # curation_filepath = output_dir / f"{asset_name}_curation_metrics.pqt"
    # pd.DataFrame(curation_metrics).to_parquet(curation_filepath)

    return qc_filepath
