import panel as pn
from panel.custom import PyComponent
from zombie.layout import OUTER_STYLE
import altair as alt
import pandas as pd

from zombie.settings.loader_settings import loader_settings


class TimeView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        loader_settings.param.watch(self._start_time_changed, "start_time")
        loader_settings.param.watch(self._end_time_changed, "end_time")

        self.plot_pane = pn.pane.Vega()
        self._update_plot()

    def _create_time_chart(self, start_time, end_time):
        """Create an Altair bar chart showing vertical bars at start and end times"""

        # Handle case where times might be None
        if start_time is None or end_time is None:
            # Create empty chart
            data = pd.DataFrame({"time_type": [], "datetime": [], "height": []})
        else:
            # Convert unix timestamps to datetime objects (not strings)
            start_datetime = pd.to_datetime(start_time, unit="s")
            end_datetime = pd.to_datetime(end_time, unit="s")

            data = pd.DataFrame(
                {
                    "time_type": ["Start Time", "End Time"],
                    "datetime": [start_datetime, end_datetime],  # Use datetime objects, not strings
                    "height": [1, 1],  # Fixed height for vertical bars
                }
            )
        
        brush = alt.selection_interval(encodings=['x'], name="time_brush")

        # Create the chart with vertical bars on a timeline
        chart = (
            alt.Chart(data)
            .mark_bar(width=10)
            .add_params(brush)
            .encode(
                x=alt.X("datetime:T", title="Date", axis=alt.Axis(labelAngle=-45)),  # Use temporal scale
                y=alt.Y("height:Q", title="", axis=alt.Axis(labels=False, ticks=False, grid=False)),
                color=alt.Color(
                    "time_type:N", scale=alt.Scale(range=["#1f77b4", "#ff7f0e"]), legend=alt.Legend(title="Event Type")
                ),
                tooltip=["time_type:N", "datetime:T"],  # Use datetime in tooltip
            )
            .properties(width=800, height=100, title="Data Time Range")
        )

        return chart

    def _update_plot(self):
        """Update the plot with current start and end times"""
        chart = self._create_time_chart(loader_settings.start_time, loader_settings.end_time)
        self.plot_pane.object = chart

    def _start_time_changed(self, event):
        print(f"Start time changed to: {event.new}")
        self._update_plot()

    def _end_time_changed(self, event):
        print(f"End time changed to: {event.new}")
        self._update_plot()

    def __panel__(self):
        return pn.Row(
            self.plot_pane,
            styles=OUTER_STYLE,
            sizing_mode="stretch_width",
            height=200,
        )
