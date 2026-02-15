"""Settings and modals for data loaders"""

from datetime import datetime
import param
from zombie_squirrel.acorns import ACORN_REGISTRY
from panel.custom import PyComponent
import panel as pn

from zombie.settings.query_settings import query_settings
from zombie_squirrel import asset_basics


class LoaderSettings(PyComponent):

    start_time = param.Number(default=None, allow_None=True)
    end_time = param.Number(default=None, allow_None=True)
    session_times = param.List(default=[])

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing LoaderSettings")

        header = pn.pane.Markdown("### Loaders to run")

        self.loader_checkboxes = pn.widgets.CheckBoxGroup(
            name="Loaders",
            options=[],
            inline=True,
        )

        query_settings.project_selector.param.watch(self._update_options, "value")

        self.panel = pn.Column(
            header,
            self.loader_checkboxes,
        )

        self._update_options(query_settings.project_names)

    def _get_unique_modalities(self, project_names):
        """Get unique modalities from asset_basics DataFrame."""
        if not project_names:
            return []

        # Ensure project_names is a list
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        df = asset_basics()
        filtered_df = df[df["project_name"].isin(list(project_names))]

        all_modalities = []
        for modalities_list in filtered_df["modalities"].dropna():
            if isinstance(modalities_list, list):
                for mod in modalities_list:
                    if isinstance(mod, dict) and "abbreviation" in mod:
                        all_modalities.append(mod["abbreviation"])

        return list(set(all_modalities))

    def _get_acquisition_time_range(self, project_names):
        """Get acquisition time range from asset_basics DataFrame."""
        if not project_names:
            return None

        # Ensure project_names is a list
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        df = asset_basics()
        filtered_df = df[df["project_name"].isin(list(project_names))]

        if filtered_df.empty:
            return None

        min_time = filtered_df["acquisition_start_time"].min()
        max_time = filtered_df["acquisition_start_time"].max()

        return (min_time, max_time) if min_time and max_time else None

    def _get_acquisition_start_end_times(self, project_names):
        """Get acquisition start/end times from asset_basics DataFrame."""
        if not project_names:
            return []

        # Ensure project_names is a list
        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        df = asset_basics()
        filtered_df = df[df["project_name"].isin(list(project_names))]

        times = []
        for _, row in filtered_df.iterrows():
            if row["acquisition_start_time"] and row["acquisition_end_time"]:
                times.append(
                    (
                        row["acquisition_start_time"],
                        row["acquisition_end_time"],
                    )
                )

        return times

    def _update_options(self, project_name):
        """Update the options for the loader checkboxes."""

        print(f"DEBUG LoaderSettings._update_options called with project_name: {project_name}")
        new_session_times = self._get_acquisition_start_end_times(project_name)
        print(f"DEBUG LoaderSettings: Got {len(new_session_times)} session times")
        self.session_times = new_session_times
        print(f"DEBUG LoaderSettings: Set session_times param to {len(self.session_times)} items")

        active_modalities = self._get_unique_modalities(project_name)
        time_range = self._get_acquisition_time_range(project_name)
        if time_range:
            self.start_time = datetime.fromisoformat(time_range[0]).timestamp() if time_range[0] else 0
            self.end_time = datetime.fromisoformat(time_range[1]).timestamp() if time_range[1] else 0
        else:
            self.start_time = None
            self.end_time = None

        print(f"Active modalities for project '{project_name}': {active_modalities}")

        options = list(ACORN_REGISTRY.keys())

        self.loader_checkboxes.options = options

    def update_options_callback(self, event):
        self._update_options(event.new)

    def __panel__(self):

        return self.panel


loader_settings = LoaderSettings()
