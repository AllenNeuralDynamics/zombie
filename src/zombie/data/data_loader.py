"""Main data loading module."""

from zombie.settings.query_settings import query_settings
from zombie.settings.loader_settings import loader_settings
from zombie.data.docdb.utils import client
from zombie.data.registry import loader_registry


class DataLoader():
    """Main data loading class."""

    def __init__(self):
        """Initialize the DataLoader class.
        """
        loader_settings.loader_checkboxes.param.watch(
            self._on_loader_change, 'value')
        
    def _on_loader_change(self, event):
        """Handle changes in the selected loaders."""
        print(f"Selected loaders changed to: {event.new}")
        
        filter_query = query_settings.query()
        
        data_assets = client.retrieve_docdb_records(
            filter_query=filter_query,
            projection={"name": 1},
        )
        print(f"Number of data assets matching query {filter_query}: {len(data_assets)}")
        
        asset_paths = []
        for asset in data_assets:
            data_asset_paths = {}
            for registry in loader_registry:
                if registry.name in event.new:
                    print(f"Loading data for asset: {asset['name']} using loader: {registry.name}")
                    data_asset_paths[registry.name] = registry.load_function(asset['name'])
            asset_paths.append(data_asset_paths)
        
        print(f"Data loading complete. Loaded data for {len(asset_paths)} assets.")
