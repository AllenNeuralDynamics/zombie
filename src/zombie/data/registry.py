"""Registry of loaders

Used by zombie to populate options for what loaders a user wants to have run and then to call the appropriate function.
"""
from typing import Callable
from zombie.data.docdb.mongodb_loaders import metadata_qc_loader
from pydantic import BaseModel


class LoaderRegistryItem(BaseModel):
    name: str
    modality_abbreviation: str
    load_function: Callable


loader_registry = [
    LoaderRegistryItem(
        name="QC Metrics",
        modality_abbreviation="all",
        load_function=metadata_qc_loader,
    ),
]
