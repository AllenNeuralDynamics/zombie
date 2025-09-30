"""Panel Modal combining all settings"""

from panel.custom import PyComponent
import panel as pn


class SettingsView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        from .query_settings import query_settings
        from .loader_settings import loader_settings

        self.panel = pn.Modal(
            query_settings,
            loader_settings,
        )

    def __panel__(self):
        return self.panel


settings_view = SettingsView()
