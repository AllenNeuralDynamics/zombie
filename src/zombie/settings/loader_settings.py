"""Settings and modals for data loaders"""

from zombie.data.registry import loader_registry
from panel.custom import PyComponent
import panel as pn

from zombie.settings.query_settings import query_settings
from zombie.data.docdb.utils import get_unique_modalities


class LoaderSettings(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
        print("Initializing LoaderSettings")

        header = pn.pane.Markdown("### Loaders to run")

        self.loader_checkboxes = pn.widgets.CheckBoxGroup(
            name="Loaders",
            options=[],
            inline=True,
            disabled=True,
        )

        query_settings.project_selector.param.watch(self._update_options, 'value')

        self.panel = pn.Column(
            header,
            self.loader_checkboxes,
        )

    def _update_options(self, event):
        """Update the options for the loader checkboxes."""
        
        project_name = event.new

        active_modalities = get_unique_modalities(project_name)
        print(f"Active modalities for project '{project_name}': {active_modalities}")

        options = [
            item.name for item in loader_registry
            if item.modality_abbreviation == "all" or item.modality_abbreviation in active_modalities
        ]

        self.loader_checkboxes.options = options

    def __panel__(self):

        return self.panel


loader_settings = LoaderSettings()
