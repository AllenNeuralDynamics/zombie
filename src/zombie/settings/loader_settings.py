"""Settings and modals for data loaders"""

from datetime import datetime
import param
from zombie.data.registry import loader_registry
from panel.custom import PyComponent
import panel as pn

from zombie.settings.query_settings import query_settings
from zombie.data.docdb.utils import get_unique_modalities, get_acquisition_time_range


class LoaderSettings(PyComponent):

    start_time = param.Number(default=None, allow_None=True)
    end_time = param.Number(default=None, allow_None=True)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing LoaderSettings")

        header = pn.pane.Markdown("### Loaders to run")

        self.loader_checkboxes = pn.widgets.CheckBoxGroup(
            name="Loaders",
            options=[],
            inline=True,
        )

        query_settings.project_selector.param.watch(self._update_options, "value")

        self.panel = pn.Column(
            header,
            self.loader_checkboxes,
        )

    def _update_options(self, event):
        """Update the options for the loader checkboxes."""

        project_name = event.new

        active_modalities = get_unique_modalities(project_name)
        time_range = get_acquisition_time_range(project_name)
        if time_range:
            self.start_time = datetime.fromisoformat(time_range[0]).timestamp() if time_range[0] else 0
            self.end_time = datetime.fromisoformat(time_range[1]).timestamp() if time_range[1] else 0
        else:
            self.start_time = None
            self.end_time = None

        print(f"Active modalities for project '{project_name}': {active_modalities}")

        options = [
            item.name
            for item in loader_registry
            if item.modality_abbreviation == "all" or item.modality_abbreviation in active_modalities
        ]

        self.loader_checkboxes.options = options

    def __panel__(self):

        return self.panel


loader_settings = LoaderSettings()
