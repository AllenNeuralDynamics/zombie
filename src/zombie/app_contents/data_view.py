from panel.custom import PyComponent
import panel as pn
import duckdb
import hvplot.pandas
import pandas as pd
import param

from zombie.layout import OUTER_STYLE
from .data_view_settings import data_view_settings


class DataView(PyComponent):

    time_selection = param.Parameter(default=None)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Watch for time selection changes to trigger plot update
        self.param.watch(self._on_time_selection_change, "time_selection")

        # Create settings modal
        self.settings_modal = pn.Modal(
            data_view_settings,
            styles={"z-index": "1001"},
        )

        # Settings button in top right
        self.settings_button = pn.widgets.Button(
            name="⚙️",
            button_type="light",
            width=40,
            height=40,
        )
        self.settings_button.on_click(lambda event: self._open_settings())

        # Create initial panel
        self.panel = self._create_full_panel()

    def _open_settings(self):
        """Open the settings modal"""
        self.settings_modal.open = True

    def _on_time_selection_change(self, event):
        """Handle time selection changes - will trigger plot update via bound params"""
        # The plot will automatically update because time_selection is bound
        pass

    def _create_plot(
        self,
        data_type,
        x_column,
        y_column,
        by_column,
        filter_column,
        filter_values,
        xlabel,
        ylabel,
        title,
        width,
        height,
        time_selection,
    ):
        """Create plot based on current settings"""
        print(
            f"Creating plot with data_type={data_type}, x_column={x_column}, "
            f"y_column={y_column}, by_column={by_column}, filter_column={filter_column}"
        )
        # Get settings
        data_type = data_view_settings.data_type
        x_col = data_view_settings.x_column
        y_col = data_view_settings.y_column
        by_col = data_view_settings.by_column if data_view_settings.by_column != "None" else None
        filter_col = data_view_settings.filter_column if data_view_settings.filter_column != "None" else None
        filter_vals = data_view_settings.filter_values
        print(f"Filter column: {filter_col}, Filter values: {filter_vals}")

        # Validate settings
        if not data_type or not x_col or not y_col:
            return pn.pane.Markdown("Please configure data source and column mappings in settings.")

        # Get filepaths for selected data type
        filepaths = data_view_settings.get_filepaths()
        if not filepaths:
            return pn.pane.Markdown(f"No data files found for {data_type}.")

        # Build DuckDB query with filters for performance
        # Query all files matching the pattern
        file_pattern = "', '".join(filepaths)

        # Build WHERE clause
        where_clauses = [f"{y_col} IS NOT NULL"]

        # Add time filter if x_column is 'ts' and time_selection exists
        has_time_selection = (
            x_col == "ts"
            and time_selection is not None
            and isinstance(time_selection, dict)
            and "datetime" in time_selection
        )
        if has_time_selection:
            time_bounds = time_selection["datetime"]
            if len(time_bounds) == 2:
                # Convert from milliseconds to seconds (Unix timestamp format in parquet)
                min_ts = time_bounds[0] / 1000.0
                max_ts = time_bounds[1] / 1000.0
                where_clauses.append(f"ts BETWEEN {min_ts} AND {max_ts}")
                print(f"✓ Applying time filter: ts BETWEEN {min_ts} AND {max_ts}")
        elif x_col == "ts":
            print(f"✗ No time filter applied (time_selection={time_selection})")

        # Add filter column condition if specified
        if filter_col and filter_vals:
            # Use LOWER(TRIM()) for string comparison like original code
            # Build individual conditions for each filter value
            filter_conditions = []
            for val in filter_vals:
                # Escape single quotes in the value
                escaped_val = str(val).replace("'", "''").lower()
                filter_conditions.append(f"LOWER(TRIM({filter_col})) = '{escaped_val}'")

            # Combine with OR since we want to keep any of the selected values
            if filter_conditions:
                where_clauses.append(f"({' OR '.join(filter_conditions)})")

        where_clause = " AND ".join(where_clauses)

        query = f"""
        SELECT *
        FROM read_parquet(['{file_pattern}'])
        WHERE {where_clause}
        """

        try:
            df = duckdb.execute(query).df()
        except Exception as e:
            return pn.pane.Markdown(f"Error loading data: {str(e)}")

        if df.empty:
            return pn.pane.Markdown("No data found with current settings.")

        # Convert numeric columns if needed
        for col in [x_col, y_col]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        # Create plot using hvplot
        hover_cols = data_view_settings.hover_cols if data_view_settings.hover_cols else []
        plot_kwargs = {
            "x": x_col,
            "y": y_col,
            "title": data_view_settings.title,
            "xlabel": data_view_settings.xlabel,
            "ylabel": data_view_settings.ylabel,
            "width": data_view_settings.width,
            "height": data_view_settings.height,
            "tools": data_view_settings.tools,
            "hover_cols": [c for c in hover_cols if c in df.columns],
        }

        if by_col and by_col in df.columns:
            plot_kwargs["by"] = by_col

        chart = df.hvplot.scatter(**plot_kwargs)

        return pn.pane.HoloViews(chart)

    def _create_full_panel(self):
        """Create the full panel with settings button and plot"""
        # Header with settings button
        header = pn.Row(
            pn.Spacer(),
            self.settings_button,
            sizing_mode="stretch_width",
        )

        data_plot = pn.bind(
            self._create_plot,
            data_view_settings.param.data_type,
            data_view_settings.param.x_column,
            data_view_settings.param.y_column,
            data_view_settings.param.by_column,
            data_view_settings.param.filter_column,
            data_view_settings.param.filter_values,
            data_view_settings.param.xlabel,
            data_view_settings.param.ylabel,
            data_view_settings.param.title,
            data_view_settings.param.width,
            data_view_settings.param.height,
            self.param.time_selection,
        )

        return pn.Column(
            header,
            data_plot,
            self.settings_modal,
            styles=OUTER_STYLE,
        )

    def __panel__(self):
        return self.panel
