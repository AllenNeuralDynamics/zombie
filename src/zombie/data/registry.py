"""Registry of loaders

Used by zombie to populate options for what loaders a user wants to have run and then to call the appropriate function.
"""

from pathlib import Path
from typing import Callable
from zombie.data.docdb.mongodb_loaders import metadata_qc_value_loader
from pydantic import BaseModel


class LoaderRegistryItem(BaseModel):
    name: str
    modality_abbreviation: str
    # Load functions return both the file path (or None if loading failed) and a list of columns in the loaded data
    load_function: Callable[[str], Path | None]
    columns: list[str]


loader_registry = [
    LoaderRegistryItem(
        name="QC Metrics",
        modality_abbreviation="all",
        load_function=metadata_qc_value_loader,
        columns=[
            "object_type",
            "name",
            "modality",
            "stage",
            "value",
            "status_history",
            "description",
            "reference",
            "tags",
            "evaluated_assets",
            "subject_id",
            "ts",
        ],
    ),
]
