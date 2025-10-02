"""View settings

Settings to control with view figures are being added into the main view.
"""

import panel as pn
from panel.custom import PyComponent


class ViewSettings(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing ViewSettings")

        header = pn.pane.Markdown("### View settings")

        self.panel = pn.Column(
            header,
            pn.pane.Markdown("No view settings available yet."),
        )

    def __panel__(self):

        return self.panel
