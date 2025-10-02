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

    def __panel__(self):
        # Query parquet files using DuckDB
        data_path = Path(__file__).parent.parent.parent.parent / "data"
        query = f"""
        SELECT name, value, ts, subject_id
        FROM read_parquet('{data_path}/qc-metrics_*.pqt')
        WHERE LOWER(TRIM(name)) = 'intensity stability'
        ORDER BY ts
        """

        try:
            df = duckdb.execute(query).df()

            if not df.empty:
                # Convert unix timestamp to datetime
                df["datetime"] = pd.to_datetime(df["ts"], unit="s")

                # Convert value to numeric if it's not already
                df["value"] = pd.to_numeric(df["value"], errors="coerce")

                # Create Altair chart
                chart = (
                    alt.Chart(df)
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
            else:
                return pn.Column(
                    pn.pane.Markdown("No Intensity Stability data found."),
                    styles=OUTER_STYLE,
                )
        except Exception as e:
            return pn.Column(
                pn.pane.Markdown(f"Error loading data: {str(e)}"),
                styles=OUTER_STYLE,
            )
