"""Settings for DataView plot configuration"""

import param
import panel as pn
from panel.custom import PyComponent

from zombie.settings.loader_settings import loader_settings
from zombie.settings.query_settings import query_settings
from zombie_squirrel.acorns import ACORN_REGISTRY


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

        self._update_data_types()

        loader_settings.loader_checkboxes.param.watch(self._on_loaders_changed, "value")

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

        self.param.watch(self._update_column_options, "data_type")
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

    def _on_loaders_changed(self, event):
        self._update_data_types()

    def _update_data_types(self):
        enabled_loaders = loader_settings.loader_checkboxes.value if loader_settings.loader_checkboxes.value else []
        self.param.data_type.objects = enabled_loaders
        if enabled_loaders and (not self.data_type or self.data_type not in enabled_loaders):
            self.data_type = enabled_loaders[0]
            self._update_column_options()

    def _load_sample_data(self, data_type):
        if data_type not in ACORN_REGISTRY:
            return None
        
        subject_ids = query_settings.get_matching_subject_ids()[:1]
        asset_names = query_settings.get_matching_asset_names()[:1]
        
        if not subject_ids or not asset_names:
            return None
        
        try:
            loader_func = ACORN_REGISTRY[data_type]
            df = loader_func(subject_ids, asset_names)
            return df
        except Exception as e:
            print(f"Error loading sample data for {data_type}: {e}")
            return None

    def _update_column_options(self, *events):
        if not self.data_type:
            return
        
        sample_df = self._load_sample_data(self.data_type)
        if sample_df is None or sample_df.empty:
            columns = []
        else:
            columns = list(sample_df.columns)
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
        if not self.filter_column or self.filter_column == "None":
            self.filter_values_selector.options = []
            self.filter_values = []
            return

        print(f"Filter column set to: {self.filter_column}")
        self.filter_values_selector.options = []
        self.filter_values = []

    def get_subject_ids(self):
        return query_settings.get_matching_subject_ids()

    def get_asset_names(self):
        return query_settings.get_matching_asset_names()

    def __panel__(self):
        return self.panel


data_view_settings = DataViewSettings()
