from panel.custom import PyComponent
import panel as pn

from zombie.layout import OUTER_STYLE


class SpaceView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

    def __panel__(self):
        return pn.Column(
            styles=OUTER_STYLE,
        )
