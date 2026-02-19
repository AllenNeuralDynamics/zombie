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

        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        df = asset_basics()
        filtered_df = df[df["project_name"].isin(list(project_names))]

        if filtered_df.empty:
            return None

        valid_times = filtered_df["acquisition_start_time"].dropna()
        
        if valid_times.empty:
            return None
        
        min_time = valid_times.min()
        max_time = valid_times.max()

        return (min_time, max_time) if min_time and max_time else None

    def _get_acquisition_start_end_times(self, project_names):
        """Get acquisition start/end times from asset_basics DataFrame."""
        if not project_names:
            print("DEBUG _get_acquisition_start_end_times: No project names provided")
            return []

        if not isinstance(project_names, (list, tuple)):
            project_names = [project_names]

        print(f"DEBUG _get_acquisition_start_end_times: Filtering for projects: {project_names}")
        
        df = asset_basics()
        print(f"DEBUG _get_acquisition_start_end_times: asset_basics has {len(df)} rows")
        print(f"DEBUG _get_acquisition_start_end_times: Unique projects in df: {df['project_name'].unique()[:5]}...")
        
        filtered_df = df[df["project_name"].isin(list(project_names))]
        print(f"DEBUG _get_acquisition_start_end_times: Filtered to {len(filtered_df)} rows")

        times = []
        for idx, row in filtered_df.iterrows():
            if row["acquisition_start_time"] and row["acquisition_end_time"]:
                times.append(
                    (
                        row["acquisition_start_time"],
                        row["acquisition_end_time"],
                    )
                )
            else:
                start_val = row.get('acquisition_start_time')
                end_val = row.get('acquisition_end_time')
                print(f"DEBUG _get_acquisition_start_end_times: Row {idx} missing times")
                print(f"  start={start_val}, end={end_val}")

        print(f"DEBUG _get_acquisition_start_end_times: Returning {len(times)} valid time ranges")
        return times

    def _update_options(self, event_or_value):
        """Update the options for the loader checkboxes."""

        if hasattr(event_or_value, 'new'):
            project_names = event_or_value.new
            print(f"DEBUG LoaderSettings._update_options: Received Event with value: {project_names}")
        else:
            project_names = event_or_value
            print(f"DEBUG LoaderSettings._update_options: Received direct value: {project_names}")

        print(f"DEBUG LoaderSettings._update_options: project_names type = {type(project_names)}")
        print(f"DEBUG LoaderSettings._update_options: project_names = {project_names}")

        new_session_times = self._get_acquisition_start_end_times(project_names)
        print(f"DEBUG LoaderSettings: Got {len(new_session_times)} session times")
        if new_session_times:
            print(f"DEBUG LoaderSettings: First session time: {new_session_times[0]}")
        
        self.session_times = new_session_times
        print(f"DEBUG LoaderSettings: Set session_times param to {len(self.session_times)} items")

        active_modalities = self._get_unique_modalities(project_names)
        time_range = self._get_acquisition_time_range(project_names)
        if time_range:
            self.start_time = datetime.fromisoformat(time_range[0]).timestamp() if time_range[0] else 0
            self.end_time = datetime.fromisoformat(time_range[1]).timestamp() if time_range[1] else 0
        else:
            self.start_time = None
            self.end_time = None

        print(f"DEBUG LoaderSettings: Active modalities: {active_modalities}")
        print(f"DEBUG LoaderSettings: Time range: start={self.start_time}, end={self.end_time}")

        excluded_acorns = {
            'asset_basics', 
            'raw_to_derived', 
            'source_data', 
            'unique_project_names', 
            'unique_subject_ids'
        }
        options = [k for k in ACORN_REGISTRY.keys() if k not in excluded_acorns]

        self.loader_checkboxes.options = options

    def update_options_callback(self, event):
        self._update_options(event.new)

    def __panel__(self):

        return self.panel


loader_settings = LoaderSettings()
