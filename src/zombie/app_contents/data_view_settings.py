"""Settings for DataView plot configuration"""

import param
import panel as pn
from panel.custom import PyComponent

from zombie.settings.loader_settings import loader_settings
from zombie.settings.query_settings import query_settings
from zombie_squirrel.acorns import ACORN_REGISTRY
import zombie_squirrel
from .data_view_utils import get_unique_column_values


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
    width = param.Integer(default=1200, bounds=(300, 2000))
    height = param.Integer(default=800, bounds=(200, 1200))

    # Advanced settings
    tools = param.List(default=["hover", "pan", "wheel_zoom", "box_zoom", "reset"])
    hover_cols = param.List(default=[])

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        print("[DEBUG] DataViewSettings initializing...")

        self._update_data_types()

        loader_settings.loader_checkboxes.param.watch(self._on_loaders_changed, "value")

        # Create UI components
        # Data source selection
        self.data_type_selector = pn.widgets.Select.from_param(
            self.param.data_type, name="Data Type", width=250, sizing_mode="fixed"
        )

        # Filter section
        self.filter_column_selector = pn.widgets.Select.from_param(
            self.param.filter_column, name="Filter Column", width=250, sizing_mode="fixed"
        )
        self.filter_values_selector = pn.widgets.MultiChoice.from_param(
            self.param.filter_values, name="Keep Values", width=250, sizing_mode="fixed"
        )

        # Column mapping section
        self.x_selector = pn.widgets.Select.from_param(self.param.x_column, name="X", width=250, sizing_mode="fixed")
        self.y_selector = pn.widgets.Select.from_param(self.param.y_column, name="Y", width=250, sizing_mode="fixed")
        self.by_selector = pn.widgets.Select.from_param(
            self.param.by_column, name="Color By", width=250, sizing_mode="fixed"
        )

        # Appearance section
        self.xlabel_input = pn.widgets.TextInput.from_param(self.param.xlabel, name="X Label", width=250, sizing_mode="fixed")
        self.ylabel_input = pn.widgets.TextInput.from_param(self.param.ylabel, name="Y Label", width=250, sizing_mode="fixed")
        self.title_input = pn.widgets.TextInput.from_param(self.param.title, name="Title", width=250, sizing_mode="fixed")
        self.width_input = pn.widgets.IntInput.from_param(self.param.width, name="Width", width=120, sizing_mode="fixed")
        self.height_input = pn.widgets.IntInput.from_param(self.param.height, name="Height", width=120, sizing_mode="fixed")

        self.param.watch(self._update_filter_values_options, "filter_column")

        # Initialize with first data type if available
        if self.param.data_type.objects:
            print(f"[DEBUG] Setting initial data_type to: {self.param.data_type.objects[0]}")
            self.data_type = self.param.data_type.objects[0]
            self._update_column_options()
        else:
            print("[DEBUG] No data types available during initialization")

        size_row = pn.Row(self.width_input, self.height_input, sizing_mode="fixed")

        self.panel = pn.Column(
            pn.pane.Markdown("**Data Source**", margin=(5, 5)),
            self.data_type_selector,
            pn.pane.Markdown("**Filtering**", margin=(10, 5, 5, 5)),
            self.filter_column_selector,
            self.filter_values_selector,
            pn.pane.Markdown("**Columns**", margin=(10, 5, 5, 5)),
            self.x_selector,
            self.y_selector,
            self.by_selector,
            pn.pane.Markdown("**Appearance**", margin=(10, 5, 5, 5)),
            self.xlabel_input,
            self.ylabel_input,
            self.title_input,
            size_row,
            width=1200,
            sizing_mode="fixed",
        )

    def _on_loaders_changed(self, event):
        print(f"[DEBUG] Loaders changed event: {event.new}")
        self._update_data_types()

    def _update_data_types(self):
        enabled_loaders = loader_settings.loader_checkboxes.value if loader_settings.loader_checkboxes.value else []
        print(f"[DEBUG] Updating data types. Enabled loaders: {enabled_loaders}")
        self.param.data_type.objects = enabled_loaders
        if enabled_loaders and (not self.data_type or self.data_type not in enabled_loaders):
            print(f"[DEBUG] Setting data_type to first enabled loader: {enabled_loaders[0]}")
            self.data_type = enabled_loaders[0]
            self._update_column_options()
        else:
            print(f"[DEBUG] Current data_type: {self.data_type}")

    def _get_columns_for_loader(self, data_type):
        print(f"[DEBUG] Getting columns for loader: {data_type}")
        if data_type not in ACORN_REGISTRY:
            print(f"[DEBUG] {data_type} not in ACORN_REGISTRY")
            return []

        column_func_name = f"{data_type}_columns"
        
        if data_type == "quality_control":
            column_func_name = "qc_columns"
        
        print(f"[DEBUG] Looking for column function: {column_func_name}")
        if not hasattr(zombie_squirrel, column_func_name):
            print(f"[DEBUG] Column function '{column_func_name}' not found in zombie_squirrel")
            return []

        try:
            column_func = getattr(zombie_squirrel, column_func_name)
            columns = column_func()
            print(f"[DEBUG] Retrieved {len(columns) if columns else 0} columns: {columns}...")
            return columns if columns else []
        except Exception as e:
            print(f"[DEBUG] Error getting columns for {data_type}: {e}")
            return []

    def _update_column_options(self, *events):
        print(f"[DEBUG] Updating column options for data_type: {self.data_type}")
        if not self.data_type:
            print("[DEBUG] No data_type set, skipping column update")
            return

        columns = self._get_columns_for_loader(self.data_type)
        print(f"[DEBUG] Setting column options with {len(columns)} columns")
        self.param.x_column.objects = columns
        self.param.y_column.objects = columns
        self.param.by_column.objects = ["None"] + columns
        self.param.filter_column.objects = ["None"] + columns

        if not self.x_column or self.x_column not in columns:
            self.x_column = columns[0] if columns else None
            print(f"[DEBUG] Set x_column to: {self.x_column}")
        if not self.y_column or self.y_column not in columns:
            self.y_column = columns[1] if len(columns) > 1 else columns[0] if columns else None
            print(f"[DEBUG] Set y_column to: {self.y_column}")
        if not self.by_column or (self.by_column not in columns and self.by_column != "None"):
            self.by_column = "None"
            print(f"[DEBUG] Set by_column to: {self.by_column}")
        if not self.filter_column or (self.filter_column not in columns and self.filter_column != "None"):
            self.filter_column = "None"
            print(f"[DEBUG] Set filter_column to: {self.filter_column}")

        self.hover_cols = [col for col in [self.x_column, self.y_column, self.by_column] if col and col != "None"]
        print(f"[DEBUG] Updated hover_cols: {self.hover_cols}")

    def _update_filter_values_options(self, *events):
        if not self.filter_column or self.filter_column == "None":
            self.filter_values_selector.options = []
            self.filter_values = []
            return

        print(f"[DEBUG] Loading unique values for filter column: {self.filter_column}")
        
        if not self.data_type or self.data_type not in ACORN_REGISTRY:
            self.filter_values_selector.options = []
            return
        
        subject_ids = self.get_subject_ids()
        asset_names = self.get_asset_names()
        
        if not subject_ids or not asset_names:
            self.filter_values_selector.options = []
            return
        
        subject_ids_clean = [s for s in subject_ids[:10] if s is not None]
        asset_names_clean = [a for a in asset_names if a is not None]
        
        unique_values = get_unique_column_values(
            self.data_type,
            tuple(sorted(subject_ids_clean)),
            tuple(sorted(asset_names_clean)),
            self.filter_column,
            limit=100,
            max_files=10
        )
        
        self.filter_values_selector.options = unique_values

    def get_subject_ids(self):
        print(f"[DATA_VIEW_SETTINGS] get_subject_ids called")
        result = query_settings.get_matching_subject_ids()
        print(f"[DATA_VIEW_SETTINGS] Returning {len(result)} subject IDs")
        return result

    def get_asset_names(self):
        print(f"[DATA_VIEW_SETTINGS] get_asset_names called")
        result = query_settings.get_matching_asset_names()
        print(f"[DATA_VIEW_SETTINGS] Returning {len(result)} asset names")
        return result

    def __panel__(self):
        return self.panel


data_view_settings = DataViewSettings()
