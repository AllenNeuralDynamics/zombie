"""Registry of loaders

Used by zombie to populate options for what loaders a user wants to have run and then to call the appropriate function.
"""
from typing import Callable
from zombie.data.mongodb_loaders import metadata_qc_loader
from pydantic import BaseModel
from panel.custom import PyComponent


class LoaderRegistryItem(BaseModel):
    name: str
    modality_abbreviation: str
    function: Callable


loader_registry = [
    LoaderRegistryItem(
        name="QC Metrics",
        modality_abbreviation="all",
        function=metadata_qc_loader,
    ),
]


class LoaderPanel(PyComponent):
    """Panel component for selecting loaders to run"""

    def __init__(self, **params):
        super().__init__(**params)