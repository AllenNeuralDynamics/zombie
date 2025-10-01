"""Main data loading module."""

from zombie.settings.loader_settings import loader_settings


class DataLoader():
    """Main data loading class."""

    def __init__(self):
        """Initialize the DataLoader class.
        """
        loader_settings.loader_checkboxes.param.watch(
            self._on_loader_change, 'value')
        
    def _on_loader_change(self, event):
        """Handle changes in the selected loaders."""
        selected_loaders = event.new
        print(f"Selected loaders changed to: {selected_loaders}")
        # Here you would add logic to handle the change in selected loaders.
        # For example, you might want to load data using the selected loaders.
