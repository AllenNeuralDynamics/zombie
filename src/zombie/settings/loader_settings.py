"""Settings and modals for data loaders"""

from zombie.data.registry import loader_registry
from panel.custom import PyComponent
import panel as pn


class LoaderSettings(PyComponent):
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        header = pn.pane.Markdown("### Loaders to run")

        self.loader_checkboxes = pn.widgets.CheckBoxGroup(
            name="Loaders",
            options=[item.name for item in loader_registry],
            inline=True,
        )

        self.panel = pn.Column(
            header,
            self.loader_checkboxes,
        )

    def __panel__(self):

        return self.panel


loader_settings = LoaderSettings()
