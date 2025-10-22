from typing import Optional
import panel as pn
from panel.custom import PyComponent
from zombie.layout import OUTER_STYLE, AIND_COLORS
import holoviews as hv
from holoviews import streams
import hvplot.pandas
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
    selection = param.Parameter(default=None)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        loader_settings.param.watch(self._update_plot, "session_times")

        self.plot_container = pn.Column(
            pn.pane.Markdown("No session data available", sizing_mode="stretch_width", height=150),
            sizing_mode="stretch_width"
        )
        self.box_stream = None
        self.selection_overlay = None
        self.base_chart = None
        
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

    def _on_selection(self, event):
        bounds = event.new
        if bounds and len(bounds) == 4:
            x0, y0, x1, y1 = bounds
            if x0 is not None and x1 is not None:
                min_x = min(x0, x1)
                max_x = max(x0, x1)
                # Bounds are already in milliseconds (chart's coordinate system)
                # Convert to datetime for display, but store milliseconds for filtering
                datetime_range = [pd.to_datetime(min_x, unit='ms'), pd.to_datetime(max_x, unit='ms')]
                self.selection = {
                    'datetime': [min_x, max_x]  # Store as milliseconds
                }
                print(f"Time selection: {datetime_range[0]} to {datetime_range[1]}")
                self._update_selection_overlay(min_x, max_x)
            else:
                self.selection = None
                print("Time selection cleared")
                self._update_selection_overlay(None, None)
        else:
            self.selection = None
            print("Time selection cleared")
            self._update_selection_overlay(None, None)

    def _update_selection_overlay(self, min_x, max_x):
        """Update the plot with a selection overlay rectangle"""
        if self.base_chart is None:
            return
        
        if min_x is not None and max_x is not None:
            # Create a semi-transparent rectangle for the selection
            selection_rect = hv.Rectangles([(min_x, 0, max_x, 1)]).opts(
                color='gray',
                alpha=0.3,
                line_width=0,
            )
            combined_chart = self.base_chart * selection_rect
        else:
            # No selection, just show the base chart
            combined_chart = self.base_chart
        
        # Update the plot container
        new_pane = pn.pane.HoloViews(combined_chart, sizing_mode="stretch_width", height=150)
        self.plot_container.clear()
        self.plot_container.append(new_pane)

    def _create_time_chart(self, start_end_times: list[tuple]):
        
        print(f"DEBUG: Received {len(start_end_times)} sessions")
        print(f"DEBUG: First few sessions: {start_end_times[:3]}")
        
        if not start_end_times:
            print("DEBUG: Using fake data")
            start_end_times = [
                (pd.Timestamp('2024-01-01 10:00:00'), pd.Timestamp('2024-01-01 12:00:00')),
                (pd.Timestamp('2024-01-02 10:00:00'), pd.Timestamp('2024-01-02 12:00:00')),
                (pd.Timestamp('2024-01-03 10:00:00'), pd.Timestamp('2024-01-03 12:00:00')),
            ]
        
        rectangles = []
        min_time = None
        max_time = None
        
        for i, (start_time, end_time) in enumerate(start_end_times):
            if start_time is not None and end_time is not None:
                start_datetime = pd.to_datetime(start_time)
                end_datetime = pd.to_datetime(end_time)
                print(f"DEBUG: Session {i}: {start_datetime} to {end_datetime}")
                
                start_ms = start_datetime.timestamp() * 1000
                end_ms = end_datetime.timestamp() * 1000
                
                rectangles.append((
                    start_ms,
                    0,
                    end_ms,
                    1,
                    f"Session {i+1}"
                ))
                
                if min_time is None or start_ms < min_time:
                    min_time = start_ms
                if max_time is None or end_ms > max_time:
                    max_time = end_ms

        if not rectangles:
            return hv.Curve([]).opts(title="No sessions available")
        
        rectangles = rectangles[:50]
        
        print(f"DEBUG: Created {len(rectangles)} rectangles")
        print(f"DEBUG: First rectangle: {rectangles[0] if rectangles else 'None'}")
        print(f"DEBUG: X range: {min_time} to {max_time}")

        from bokeh.models import DatetimeTickFormatter
        
        self.base_chart = hv.Rectangles(rectangles, vdims='session').opts(
            color=AIND_COLORS["light_blue"],
            alpha=0.8,
            title="Session times",
            xlabel="Time",
            ylabel="",
            width=800,
            height=150,
            tools=['box_select', 'hover', 'reset'],
            active_tools=['box_select'],
            default_tools=[],
            xlim=(min_time, max_time),
            ylim=(0, 1),
            show_grid=True,
            yaxis=None,
            xformatter=DatetimeTickFormatter(
                milliseconds='%Y-%m-%d',
                seconds='%Y-%m-%d',
                minutes='%Y-%m-%d',
                hours='%Y-%m-%d %H:%M',
                days='%Y-%m-%d',
                months='%Y-%m',
                years='%Y'
            )
        )

        # Set up the selection stream on the base chart
        if self.box_stream is None:
            self.box_stream = streams.BoundsXY(source=self.base_chart)
            self.box_stream.param.watch(self._on_selection, ['bounds'])
        else:
            self.box_stream.source = self.base_chart

        return self.base_chart

    def _update_plot(self, event: Optional[object] = None):
        """Update the plot with current start and end times"""
        try:
            session_times = getattr(event, 'new', []) if event else []
        except AttributeError:
            session_times = []

        # if not session_times or not any(session_times):
        #     new_pane = pn.pane.Markdown("No session data available", sizing_mode="stretch_width", height=150)
        # else:
        chart = self._create_time_chart(session_times)
        
        # If there's an existing selection, reapply the overlay
        if self.selection and isinstance(self.selection, dict) and 'datetime' in self.selection:
            min_x, max_x = self.selection['datetime']
            self._update_selection_overlay(min_x, max_x)
        else:
            new_pane = pn.pane.HoloViews(chart, sizing_mode="stretch_width", height=150)
            self.plot_container.clear()
            self.plot_container.append(new_pane)

    def __panel__(self):
        controls_col = pn.Column(
            pn.VSpacer(),
            self.zoom_in_button,
            self.zoom_out_button,
        )
        return pn.Row(
            self.plot_container,
            controls_col,
            styles=OUTER_STYLE,
            sizing_mode="stretch_width",
            height=250,
        )
