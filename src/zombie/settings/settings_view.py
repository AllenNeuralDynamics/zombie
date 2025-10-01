"""Panel Modal combining all settings"""

from panel.custom import PyComponent
import panel as pn

from .query_settings import query_settings
from .loader_settings import loader_settings


class SettingsView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.panel = pn.Modal(
            query_settings,
            loader_settings,
            styles={'z-index': '1001'},
        )

    def __panel__(self):
        return self.panel


settings_view = SettingsView()
