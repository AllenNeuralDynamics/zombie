"""Main data loading module."""

from zombie.settings.query_settings import query_settings
from zombie.settings.loader_settings import loader_settings
from zombie.data.docdb.utils import client
from zombie.data.registry import loader_registry
import param
import json
from pydantic import BaseModel


class TableTypeMetadata(BaseModel):
    columns: list[str]


class DataTableMetadata(BaseModel):
    data_type: str
    filepath: str


class AllTableMetadata(BaseModel):
    types: dict[str, TableTypeMetadata]
    filepaths: dict[str, list[str]]


class DataLoader(param.Parameterized):
    """Main data loading class."""

    # The loading param can be watched by view components to know when to update available column options
    loading = param.Boolean(default=False)

    def __init__(self):
        """Initialize the DataLoader class."""
        super().__init__()
        loader_settings.loader_checkboxes.param.watch(self._on_loader_change, "value")

    def _on_loader_change(self, event):
        """Handle changes in the selected loaders."""
        self.loading = True
        print(f"Selected loaders changed to: {event.new}")

        filter_query = query_settings.query()

        data_assets = client.retrieve_docdb_records(
            filter_query=filter_query,
            projection={"name": 1},
            limit=100,
        )
        print(f"Number of data assets matching query {filter_query}: {len(data_assets)}")

        all_table_metadata = AllTableMetadata(
            types={},
            filepaths={},
        )
        for asset in data_assets:
            for registry in loader_registry:
                table_type_metadata = TableTypeMetadata(
                    columns=registry.columns,
                )
                all_table_metadata.types[registry.name] = table_type_metadata
                if registry.name in event.new:
                    print(f"Loading data for asset: {asset['name']} using loader: {registry.name}")
                    try:
                        data_path = registry.load_function(asset["name"])
                        if data_path:
                            if registry.name not in all_table_metadata.filepaths:
                                all_table_metadata.filepaths[registry.name] = []
                            all_table_metadata.filepaths[registry.name].append(str(data_path))
                    except Exception as e:
                        print(f"Error loading data for asset {asset['name']} with loader {registry.name}: {e}")

        with open("data/loaded_assets.json", "w") as f:
            f.write(all_table_metadata.model_dump_json(indent=2))

        print(f"Data loading complete. Loaded data for {len(all_table_metadata.filepaths)} assets.")
        self.loading = False
