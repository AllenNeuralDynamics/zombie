from panel.custom import PyComponent
import panel as pn
import param

from zombie.app_contents.space_view import SpaceView
from zombie.app_contents.time_view import TimeView
from zombie.app_contents.data_view import DataView

from zombie.settings.settings_view import settings_view

pn.extension("modal")


class MainView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        self.settings = settings_view

        # Import modal and create gear button
        self.gear_button = self.settings.panel.create_button(
            action="toggle",
            icon="settings",
            button_type="primary",
            styles={
                "position": "fixed",
                "top": "5px",
                "right": "5px",
                "width": "30px",
                "height": "30px",
                "zIndex": "1000",
                "background": "#fff",
                "borderRadius": "50%",
                "boxShadow": "0 2px 8px rgba(0,0,0,0.15)",
            },
        )

    def __panel__(self):
        time_view = TimeView()
        space_view = SpaceView()
        data_view = DataView()

        return pn.Column(
            self.settings,
            self.gear_button,
            time_view,
            pn.Row(
                data_view,
                space_view,
            ),
        )
