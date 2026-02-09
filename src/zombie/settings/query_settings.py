"""Settings that control asset query using zombie-squirrel"""

from panel.custom import PyComponent
import panel as pn
import param

from zombie_squirrel import unique_project_names, asset_basics


class QuerySettings(PyComponent):

    project_names = param.List(default=[])
    _asset_basics_df = None

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing QuerySettings")

        # Load asset_basics DataFrame (cached by zombie-squirrel)
        self._asset_basics_df = asset_basics()

        header = pn.pane.Markdown("### Query settings")

        self.project_selector = pn.widgets.MultiChoice.from_param(
            self.param.project_names,
            name="data_description.project_name",
            options=unique_project_names(),
        )

        pn.state.location.sync(self, parameters=["project_names"])
        self.project_selector.value = self.project_names

        self.panel = pn.Column(
            header,
            self.project_selector,
        )

    def get_matching_asset_names(self):
        """Get list of asset names matching the current project selection."""
        if not self.project_selector.value:
            return []
        
        project_names = self.project_selector.value
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]
        
        filtered_df = self._asset_basics_df[
            self._asset_basics_df["project_name"].isin(list(project_names))
        ]
        return filtered_df["name"].tolist()

    def get_matching_subject_ids(self):
        """Get list of unique subject_ids matching the current project selection."""
        if not self.project_selector.value:
            return []
        
        project_names = self.project_selector.value
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]
        
        filtered_df = self._asset_basics_df[
            self._asset_basics_df["project_name"].isin(list(project_names))
        ]
        return filtered_df["subject_id"].unique().tolist()

    def __panel__(self):

        return self.panel


query_settings = QuerySettings()
