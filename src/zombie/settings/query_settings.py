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

        pn.state.location.sync(self, ["project_names"])

        self.panel = pn.Column(
            header,
            self.project_selector,
        )

    def get_matching_asset_names(self):
        """Get list of asset names matching the current project selection."""
        print(f"[QUERY_SETTINGS] get_matching_asset_names called")
        print(f"[QUERY_SETTINGS] project_selector.value: {self.project_selector.value}")
        if not self.project_selector.value:
            print(f"[QUERY_SETTINGS] ❌ No projects selected, returning empty list")
            return []

        project_names = self.project_selector.value
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        print(f"[QUERY_SETTINGS] Filtering for project_names: {project_names}")
        print(f"[QUERY_SETTINGS] asset_basics_df shape: {self._asset_basics_df.shape}")
        filtered_df = self._asset_basics_df[self._asset_basics_df["project_name"].isin(list(project_names))]
        asset_names = filtered_df["name"].tolist()
        print(f"[QUERY_SETTINGS] Found {len(asset_names)} asset names: {asset_names[:5]}..." if len(asset_names) > 5 else f"[QUERY_SETTINGS] Found {len(asset_names)} asset names: {asset_names}")
        return asset_names

    def get_matching_subject_ids(self):
        """Get list of unique subject_ids matching the current project selection."""
        print(f"[QUERY_SETTINGS] get_matching_subject_ids called")
        print(f"[QUERY_SETTINGS] project_selector.value: {self.project_selector.value}")
        if not self.project_selector.value:
            print(f"[QUERY_SETTINGS] ❌ No projects selected, returning empty list")
            return []

        project_names = self.project_selector.value
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        print(f"[QUERY_SETTINGS] Filtering for project_names: {project_names}")
        filtered_df = self._asset_basics_df[self._asset_basics_df["project_name"].isin(list(project_names))]
        subject_ids = filtered_df["subject_id"].unique().tolist()
        print(f"[QUERY_SETTINGS] Found {len(subject_ids)} subject_ids: {subject_ids[:5]}..." if len(subject_ids) > 5 else f"[QUERY_SETTINGS] Found {len(subject_ids)} subject_ids: {subject_ids}")
        return subject_ids

    def __panel__(self):

        return self.panel


query_settings = QuerySettings()
