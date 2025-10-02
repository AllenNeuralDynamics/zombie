"""Main data loading module."""

from zombie.settings.query_settings import query_settings
from zombie.settings.loader_settings import loader_settings
from zombie.data.docdb.utils import client
from zombie.data.registry import loader_registry
import param
import json
from pydantic import BaseModel


class DataTableMetadata(BaseModel):
    data_type: str
    filepath: str
    columns: list[str]


class DataLoader(param.Parameterized):
    """Main data loading class."""
    
    # The loading param can be watched by view components to know when to update available column options
    loading = param.Boolean(default=False)

    def __init__(self):
        """Initialize the DataLoader class.
        """
        super().__init__()
        loader_settings.loader_checkboxes.param.watch(
            self._on_loader_change, 'value')
        
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

        loaded_data = []
        for asset in data_assets:
            all_metadata = []
            for registry in loader_registry:
                if registry.name in event.new:
                    print(f"Loading data for asset: {asset['name']} using loader: {registry.name}")
                    try:
                        data_path, data_columns = registry.load_function(asset['name'])
                        if data_path:
                            table_metadata = DataTableMetadata(
                                data_type=registry.name,
                                filepath=str(data_path),
                                columns=data_columns,
                            )
                            all_metadata.append(table_metadata.model_dump())
                    except Exception as e:
                        print(f"Error loading data for asset {asset['name']} with loader {registry.name}: {e}")
            loaded_data.extend(all_metadata)

        with open('data/loaded_assets.json', 'w') as f:
            json.dump(loaded_data, f, indent=2)

        print(f"Data loading complete. Loaded data for {len(loaded_data)} assets.")
        self.loading = False
