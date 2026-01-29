"""Settings for DataView plot configuration"""

import json
import param
import panel as pn
from pathlib import Path
from panel.custom import PyComponent


class DataViewSettings(PyComponent):

    # Data source settings
    data_type = param.Selector(default=None, objects=[])

    # Filter settings
    filter_column = param.Selector(default=None, objects=[], allow_None=True)
    filter_values = param.List(default=[])

    # Column mapping settings
    x_column = param.Selector(default=None, objects=[])
    y_column = param.Selector(default=None, objects=[])
    by_column = param.Selector(default=None, objects=[], allow_None=True)

    # Plot appearance settings
    xlabel = param.String(default="X Axis")
    ylabel = param.String(default="Y Axis")
    title = param.String(default="Data Plot")
    width = param.Integer(default=600, bounds=(300, 2000))
    height = param.Integer(default=400, bounds=(200, 1200))

    # Advanced settings
    tools = param.List(default=["hover", "pan", "wheel_zoom", "box_zoom", "reset"])
    hover_cols = param.List(default=[])

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Load available data types from loaded_assets.json
        self._load_data_types()

        # Create UI components
        header = pn.pane.Markdown("### Data View Settings")

        # Data source selection
        data_section = pn.pane.Markdown("#### Data Source")
        self.data_type_selector = pn.widgets.Select.from_param(self.param.data_type, name="Data Type")

        # Filter section
        filter_section = pn.pane.Markdown("#### Data Filtering")
        self.filter_column_selector = pn.widgets.Select.from_param(
            self.param.filter_column, name="Filter Column (optional)"
        )
        self.filter_values_selector = pn.widgets.MultiChoice.from_param(self.param.filter_values, name="Keep Values")

        # Column mapping section
        mapping_section = pn.pane.Markdown("#### Column Mapping")
        self.x_selector = pn.widgets.Select.from_param(self.param.x_column, name="X Axis")
        self.y_selector = pn.widgets.Select.from_param(self.param.y_column, name="Y Axis")
        self.by_selector = pn.widgets.Select.from_param(self.param.by_column, name="Color By (optional)")

        # Appearance section
        appearance_section = pn.pane.Markdown("#### Plot Appearance")
        self.xlabel_input = pn.widgets.TextInput.from_param(self.param.xlabel, name="X Label")
        self.ylabel_input = pn.widgets.TextInput.from_param(self.param.ylabel, name="Y Label")
        self.title_input = pn.widgets.TextInput.from_param(self.param.title, name="Title")
        self.width_input = pn.widgets.IntInput.from_param(self.param.width, name="Width")
        self.height_input = pn.widgets.IntInput.from_param(self.param.height, name="Height")

        # Watch for data type changes to update column options
        self.param.watch(self._update_column_options, "data_type")
        # Watch for filter column changes to update filter values options
        self.param.watch(self._update_filter_values_options, "filter_column")

        # Initialize with first data type if available
        if self.param.data_type.objects:
            self.data_type = self.param.data_type.objects[0]
            self._update_column_options()

        self.panel = pn.Column(
            header,
            data_section,
            self.data_type_selector,
            filter_section,
            self.filter_column_selector,
            self.filter_values_selector,
            mapping_section,
            self.x_selector,
            self.y_selector,
            self.by_selector,
            appearance_section,
            self.xlabel_input,
            self.ylabel_input,
            self.title_input,
            self.width_input,
            self.height_input,
        )

    def _load_data_types(self):
        """Load available data types from loaded_assets.json"""
        data_path = Path(__file__).parent.parent.parent.parent / "data"
        assets_file = data_path / "loaded_assets.json"

        if assets_file.exists():
            with open(assets_file, "r") as f:
                self.loaded_assets = json.load(f)
                data_types = list(self.loaded_assets.get("types", {}).keys())
                self.param.data_type.objects = data_types
        else:
            self.loaded_assets = {"types": {}, "filepaths": {}}
            self.param.data_type.objects = []

    def _update_column_options(self, *events):
        """Update column options based on selected data type"""
        if not self.data_type or self.data_type not in self.loaded_assets.get("types", {}):
            return

        # Get available columns for the selected data type
        columns = self.loaded_assets["types"][self.data_type]["columns"]

        # Update column selectors
        self.param.x_column.objects = columns
        self.param.y_column.objects = columns
        self.param.by_column.objects = ["None"] + columns
        self.param.filter_column.objects = ["None"] + columns

        # Set defaults if not already set or if current selection is invalid
        if not self.x_column or self.x_column not in columns:
            self.x_column = columns[0] if columns else None
        if not self.y_column or self.y_column not in columns:
            self.y_column = columns[1] if len(columns) > 1 else columns[0] if columns else None
        if not self.by_column or (self.by_column not in columns and self.by_column != "None"):
            self.by_column = "None"
        if not self.filter_column or (self.filter_column not in columns and self.filter_column != "None"):
            self.filter_column = "None"

        # Update hover_cols to include selected columns
        self.hover_cols = [col for col in [self.x_column, self.y_column, self.by_column] if col and col != "None"]

    def _update_filter_values_options(self, *events):
        """Update filter values options based on selected filter column"""
        if not self.filter_column or self.filter_column == "None":
            self.filter_values_selector.options = []
            self.filter_values = []
            return

        # Get filepaths and query unique values from the filter column
        filepaths = self.get_filepaths()
        if not filepaths:
            self.filter_values_selector.options = []
            self.filter_values = []
            return

        # Query unique values from the filter column
        file_pattern = "', '".join(filepaths)
        query = f"""
        SELECT DISTINCT {self.filter_column}
        FROM read_parquet(['{file_pattern}'])
        WHERE {self.filter_column} IS NOT NULL
        ORDER BY {self.filter_column}
        """

        try:
            import duckdb

            df = duckdb.execute(query).df()
            unique_values = df[self.filter_column].tolist()
            self.filter_values_selector.options = unique_values
            # Select none by default
            self.filter_values = []
        except Exception as e:
            print(f"Error loading filter values: {e}")
            self.filter_values_selector.options = []
            self.filter_values = []

    def get_filepaths(self):
        """Get the list of filepaths for the selected data type"""
        if not self.data_type:
            return []

        filepaths = self.loaded_assets.get("filepaths", {}).get(self.data_type, [])
        # Convert to absolute paths
        data_path = Path(__file__).parent.parent.parent.parent / "data"
        return [str(data_path / Path(fp).name) for fp in filepaths]

    def __panel__(self):
        return self.panel


data_view_settings = DataViewSettings()
