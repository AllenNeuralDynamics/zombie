import panel as pn
from panel.custom import PyComponent
from zombie.layout import OUTER_STYLE

from zombie.settings.loader_settings import loader_settings


class TimeView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        loader_settings.param.watch(self._start_time_changed, "start_time")
        loader_settings.param.watch(self._end_time_changed, "end_time")

    def _init_panels(self):
        pass

    def _start_time_changed(self, event):
        print(f"Start time changed to: {event.new}")

    def _end_time_changed(self, event):
        print(f"End time changed to: {event.new}")

    def __panel__(self):
        return pn.Column(
            styles=OUTER_STYLE,
        )
