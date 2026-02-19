from panel.custom import PyComponent
import panel as pn
import hvplot.pandas
import pandas as pd
import param

from zombie.layout import OUTER_STYLE
from zombie_squirrel.acorns import ACORN_REGISTRY
from .data_view_settings import DataViewSettings
from .data_view_utils import load_dataframe_from_s3


class DataView(PyComponent):

    time_selection = param.Parameter(default=None)

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Create own settings instance for this view
        self.settings = DataViewSettings()

        # Watch for time selection changes to trigger plot update
        self.param.watch(self._on_time_selection_change, "time_selection")

        # Create plot panel that will hold the plot
        self.plot_panel = pn.Column(
            pn.pane.Markdown("Configure settings and click 'Update Plot' to generate visualization."),
            sizing_mode="fixed",
        )

        # Create update button
        self.update_button = pn.widgets.Button(
            name="Update Plot",
            button_type="primary",
            width=250,
            height=35,
            sizing_mode="fixed",
        )
        self.update_button.on_click(lambda event: self._update_plot())

        # Create initial panel
        self.panel = self._create_full_panel()

    def _update_plot(self):
        """Update the plot with current settings"""
        new_plot = self._create_plot(
            self.settings.data_type,
            self.settings.x_column,
            self.settings.y_column,
            self.settings.by_column,
            self.settings.filter_column,
            self.settings.filter_values,
            self.settings.xlabel,
            self.settings.ylabel,
            self.settings.title,
            self.settings.width,
            self.settings.height,
            self.time_selection,
        )
        self.plot_panel.clear()
        self.plot_panel.append(new_plot)

    def _on_time_selection_change(self, event):
        """Handle time selection changes - auto-update plot when time range changes"""
        self._update_plot()

    def _load_data_from_s3(self, data_type, subject_ids_tuple, asset_names_tuple):
        """Load data from S3 using duckdb - returns full unfiltered dataframe
        
        Args:
            data_type: Type of data to load
            subject_ids_tuple: Tuple of subject IDs (must be tuple for caching)
            asset_names_tuple: Tuple of asset names (must be tuple for caching)
        """
        return load_dataframe_from_s3(data_type, subject_ids_tuple, asset_names_tuple)

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
        print("\n" + "="*80)
        print("[DATA_VIEW] _create_plot called")
        print(
            f"[DATA_VIEW] Bound params: data_type={data_type}, x_column={x_column}, "
            f"y_column={y_column}, by_column={by_column}, filter_column={filter_column}"
        )
        print(f"[DATA_VIEW] time_selection={time_selection}")
        # Get settings
        data_type = self.settings.data_type
        x_col = self.settings.x_column
        y_col = self.settings.y_column
        by_col = self.settings.by_column if self.settings.by_column != "None" else None
        filter_col = self.settings.filter_column if self.settings.filter_column != "None" else None
        filter_vals = self.settings.filter_values
        print(f"[DATA_VIEW] Settings from self.settings: data_type={data_type}, x={x_col}, y={y_col}")
        print(f"[DATA_VIEW] Filter: column={filter_col}, values={filter_vals}")

        if not data_type or not x_col or not y_col:
            print(f"[DATA_VIEW] ❌ Missing required settings: data_type={data_type}, x={x_col}, y={y_col}")
            return pn.pane.Markdown("Please configure data source and column mappings in settings.")

        if data_type not in ACORN_REGISTRY:
            print(f"[DATA_VIEW] ❌ Data type '{data_type}' not in ACORN_REGISTRY")
            print(f"[DATA_VIEW] Available types: {list(ACORN_REGISTRY.keys())}")
            return pn.pane.Markdown(f"Unknown data type: {data_type}")

        subject_ids = self.settings.get_subject_ids()
        asset_names = self.settings.get_asset_names()
        print(f"[DATA_VIEW] Subject IDs: {subject_ids}")

        if not subject_ids or not asset_names:
            print(f"[DATA_VIEW] ❌ No data: subject_ids={subject_ids}, asset_names={asset_names}")
            return pn.pane.Markdown("No data assets found. Please configure query settings and enable loaders.")

        subject_ids_clean = [s for s in subject_ids if s is not None]
        asset_names_clean = [a for a in asset_names if a is not None]
        
        df = self._load_data_from_s3(data_type, tuple(sorted(subject_ids_clean)), tuple(sorted(asset_names_clean)))
        
        if df is None:
            return pn.pane.Markdown("Error loading data.")
        
        if df.empty:
            print(f"[DATA_VIEW] ❌ Empty dataframe after loading")
            return pn.pane.Markdown("No data found for selected subjects and assets.")

        print(f"[DATA_VIEW] Building local filters on cached data...")
        filter_mask = df[y_col].notna()

        has_time_selection = (
            x_col == "ts"
            and time_selection is not None
            and isinstance(time_selection, dict)
            and "datetime" in time_selection
        )
        print(f"[DATA_VIEW] Time selection check: x_col={x_col}, has_time_selection={has_time_selection}")
        if has_time_selection and "ts" in df.columns:
            time_bounds = time_selection["datetime"]
            if len(time_bounds) == 2:
                min_ts = time_bounds[0] / 1000.0
                max_ts = time_bounds[1] / 1000.0
                time_filter = (df["ts"] >= min_ts) & (df["ts"] <= max_ts)
                filter_mask &= time_filter
                print(f"[DATA_VIEW] ✓ Applying time filter: ts BETWEEN {min_ts} AND {max_ts}")

        if filter_col and filter_vals and filter_col in df.columns:
            filter_col_lower = df[filter_col].astype(str).str.strip().str.lower()
            filter_vals_lower = [str(v).strip().lower() for v in filter_vals]
            col_filter = filter_col_lower.isin(filter_vals_lower)
            print(f"[DATA_VIEW] Column filter on '{filter_col}' for values {filter_vals} matches {col_filter.sum()} rows")
            filter_mask &= col_filter

        print(f"[DATA_VIEW] Filter mask: {filter_mask.sum()} rows pass")
        df = df[filter_mask]

        if df.empty:
            print(f"[DATA_VIEW] ❌ Empty dataframe after filtering")
            return pn.pane.Markdown("No data found with current filters.")
        
        print(f"[DATA_VIEW] Final dataframe shape: {df.shape}")
        for col in [x_col, y_col]:
            if col in df.columns:
                print(f"[DATA_VIEW] {col} range: [{df[col].min()}, {df[col].max()}], NaN count: {df[col].isna().sum()}")

        # Convert timestamp to datetime if x-axis is timestamp
        if x_col == "timestamp" and x_col in df.columns:
            print(f"[DATA_VIEW] Converting timestamp to datetime for x-axis")
            df['timestamp_dt'] = pd.to_datetime(df['timestamp'], unit='s')
            x_col_display = 'timestamp_dt'
            
            # Format as date + time for better readability
            df['timestamp_formatted'] = df['timestamp_dt'].dt.strftime('%Y-%m-%d\n%H:%M:%S')
        else:
            x_col_display = x_col

        # Create plot using hvplot
        hover_cols = self.settings.hover_cols if self.settings.hover_cols else []
        
        # Add original timestamp to hover if we converted it
        if x_col == "timestamp" and "timestamp_dt" in df.columns:
            hover_cols_display = [c for c in hover_cols if c in df.columns and c != "timestamp"]
            hover_cols_display.append("timestamp_formatted")
        else:
            hover_cols_display = [c for c in hover_cols if c in df.columns]
        
        plot_kwargs = {
            "x": x_col_display,
            "y": y_col,
            "title": self.settings.title,
            "xlabel": self.settings.xlabel if self.settings.xlabel != "X Axis" else ("Timestamp" if x_col == "timestamp" else self.settings.xlabel),
            "ylabel": self.settings.ylabel,
            "width": self.settings.width,
            "height": self.settings.height,
            "tools": self.settings.tools,
            "hover_cols": hover_cols_display,
        }

        if by_col and by_col in df.columns:
            plot_kwargs["by"] = by_col
            print(f"[DATA_VIEW] Grouping by column: {by_col}")

        print(f"[DATA_VIEW] Creating plot with kwargs: {plot_kwargs}")
        try:
            chart = df.hvplot.scatter(**plot_kwargs)
            print(f"[DATA_VIEW] ✓ Plot created successfully")
            print("="*80 + "\n")
            return pn.pane.HoloViews(chart)
        except Exception as e:
            print(f"[DATA_VIEW] ❌ Error creating plot: {e}")
            import traceback
            traceback.print_exc()
            print("="*80 + "\n")
            return pn.pane.Markdown(f"Error creating plot: {str(e)}")

    def _create_full_panel(self):
        """Create the full panel with settings on left and plot on right"""
        # Settings panel with update button at top
        settings_panel = pn.Column(
            self.update_button,
            pn.layout.Divider(margin=(5, 0)),
            self.settings,
            width=270,
            sizing_mode="fixed",
            styles={"background": "#f8f9fa", "padding": "10px", "border-radius": "5px"},
        )

        return pn.Row(
            settings_panel,
            self.plot_panel,
            styles=OUTER_STYLE,
            sizing_mode="fixed",
        )

    def __panel__(self):
        return self.panel
