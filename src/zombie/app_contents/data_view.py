from panel.custom import PyComponent
import panel as pn
import duckdb
import altair as alt
import pandas as pd
from pathlib import Path

from zombie.layout import OUTER_STYLE


class DataView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Query parquet files using DuckDB
        data_path = Path(__file__).parent.parent.parent.parent / "data"
        query = f"""
        SELECT name, value, ts, subject_id
        FROM read_parquet('{data_path}/qc-metrics_*.pqt')
        WHERE LOWER(TRIM(name)) = 'intensity stability'
        ORDER BY ts
        """

        # Store the dataframe for filtering
        self.df = duckdb.execute(query).df()

        if not self.df.empty:
            # Convert unix timestamp to datetime
            self.df["datetime"] = pd.to_datetime(self.df["ts"], unit="s")
            # Convert value to numeric if it's not already
            self.df["value"] = pd.to_numeric(self.df["value"], errors="coerce")

        # Create initial panel
        self.panel = self._create_panel()

    def _create_panel(self, event=None):
        """Create panel with optional time filtering"""
        if self.df.empty:
            return pn.Column(
                pn.pane.Markdown("No Intensity Stability data found."),
                styles=OUTER_STYLE,
            )

        # Filter data based on event
        filtered_df = self.df.copy()
        if event and 'datetime' in event and len(event['datetime']) == 2:
            start_time = pd.to_datetime(event['datetime'][0], unit='ms')
            end_time = pd.to_datetime(event['datetime'][1], unit='ms')
            filtered_df = filtered_df[
                (filtered_df['datetime'] >= start_time) &
                (filtered_df['datetime'] <= end_time)
            ]

        # Create Altair chart
        chart = (
            alt.Chart(filtered_df)
            .mark_line(point=True)
            .encode(
                x=alt.X("datetime:T", title="Time"),
                y=alt.Y("value:Q", title="Intensity Stability"),
                color=alt.Color("subject_id:N", title="Subject ID"),
                tooltip=["datetime:T", "value:Q", "subject_id:N"],
            )
            .properties(width=600, height=400, title="Intensity Stability Over Time")
            .interactive()
        )

        return pn.Column(
            pn.pane.Vega(chart),
            styles=OUTER_STYLE,
        )

    def get_panel(self, event):
        """Update panel based on filtering event"""
        print(event)
        self.panel = self._create_panel(event)
        return self.panel

    def __panel__(self):
        return self.panel
