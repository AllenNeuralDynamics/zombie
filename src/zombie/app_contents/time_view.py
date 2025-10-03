from typing import Optional
import panel as pn
from panel.custom import PyComponent
from zombie.layout import OUTER_STYLE, AIND_COLORS
import altair as alt
import pandas as pd
import param
from enum import Enum

from zombie.settings.loader_settings import loader_settings


class ZoomState(Enum):

    PROJECT = 0
    YEAR = 1
    MONTH = 2
    WEEK = 3
    SESSION = 4
    HUNDRED_TRIALS = 5
    TEN_TRIALS = 6
    ONE_TRIAL = 7


class TimeView(PyComponent):

    zoom_state = param.Integer(default=ZoomState.PROJECT.value)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        loader_settings.param.watch(self._update_plot, "session_times")

        self.plot_pane = pn.pane.Vega(sizing_mode="stretch_width", height=150)
        self.zoom_in_button = pn.widgets.ButtonIcon(
            icon="plus", active_icon="check",
            styles={
                "background-color": AIND_COLORS["light_blue"], 
                "color": "white", 
                "border-radius": "50%",
            },
            width=30, height=30,
            on_click=self._increase_zoom,
        )
        self.zoom_out_button = pn.widgets.ButtonIcon(
            icon="minus",
            styles={"background-color": AIND_COLORS["light_blue"], "color": "white", "border-radius": "50%"},
            width=30, height=30,
            on_click=self._decrease_zoom,
        )
        self._update_plot()

    def _increase_zoom(self, event):
        if self.zoom_state < ZoomState.ONE_TRIAL.value:
            self.zoom_state += 1
            print(f"Zoomed in to state: {ZoomState(self.zoom_state).name}")
            # Implement zoom in logic here

    def _decrease_zoom(self, event):
        if self.zoom_state > ZoomState.PROJECT.value:
            self.zoom_state -= 1
            print(f"Zoomed out to state: {ZoomState(self.zoom_state).name}")
            # Implement zoom out logic here

    def _create_time_chart(self, start_end_times: list[tuple]):
        """Create an Altair bar chart showing horizontal bars for each session from start to end time"""

        if not start_end_times or not any(start_end_times):
            data = pd.DataFrame({"session": [], "start_time": [], "end_time": []})
        else:
            data_rows = []
            for i, (start_time, end_time) in enumerate(start_end_times):
                if start_time is not None and end_time is not None:
                    start_datetime = pd.to_datetime(start_time)
                    end_datetime = pd.to_datetime(end_time)
                    data_rows.append({
                        "session": f"Session {i+1}",
                        "start_time": start_datetime,
                        "end_time": end_datetime,
                    })
            
            data = pd.DataFrame(data_rows)

        brush = alt.selection_interval(encodings=['x'], name="time_brush")

        chart = (
            alt.Chart(data)
            .mark_bar(height=20)
            .add_params(brush)
            .encode(
                x=alt.X("start_time:T", title="Time", axis=alt.Axis(labelAngle=-45, format="%Y-%m-%d")),
                x2="end_time:T",
                y=alt.value(50),
                color=alt.value(AIND_COLORS["light_blue"]),
                tooltip=["session:N", "start_time:T", "end_time:T"],
            )
            .properties(width=800, height=100, title="Session Time Ranges")
        )

        return chart

    def _update_plot(self, event: Optional[object] = None):
        """Update the plot with current start and end times"""
        chart = self._create_time_chart(event.new if event else [])
        self.plot_pane.object = chart

    def __panel__(self):
        controls_col = pn.Column(
            pn.VSpacer(),
            self.zoom_in_button,
            self.zoom_out_button,
        )
        return pn.Row(
            self.plot_pane,
            controls_col,
            styles=OUTER_STYLE,
            sizing_mode="stretch_width",
            height=250,
        )
