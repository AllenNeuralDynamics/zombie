import json
import traceback
import panel as pn
from panel.custom import PyComponent
from aind_data_access_api.document_db import MetadataDbClient

from zombie.subject_contents.subject_view import SubjectView
from zombie.subject_contents.subject_settings import subject_settings


class SubjectApp(PyComponent):
    """Main app that fetches subject data from DocDB based on settings."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Initialize API client
        self.client = MetadataDbClient(
            host="api.allenneuraldynamics.org",
            version="v2",
        )

        # Create subject view
        self.subject_view = SubjectView()

        self.panel = pn.Column(
            self.subject_view,
            sizing_mode="stretch_both",
        )
        self.panel.loading = True

        # Watch for subject_id changes in settings
        subject_settings.param.watch(self._fetch_and_display, "subject_id")

        # Use onload to check URL after page is fully loaded
        pn.state.onload(self._on_load)

    def _merge_records(self, records):
        """Merge multiple records, combining unique procedures and all acquisitions."""
        if not records:
            return {}

        # Start with the first record for shared metadata (subject, data_description)
        merged = {
            "subject": records[0].get("subject", {}),
            "data_description": records[0].get("data_description", {}),
        }

        # Collect unique procedures across all records
        # Procedures is a dict with keys like 'subject_procedures', 'specimen_procedures'
        all_subject_procedures = []
        all_specimen_procedures = []
        seen_subject_procs = set()
        seen_specimen_procs = set()

        for record in records:
            procedures_dict = record.get("procedures", {})

            # Handle subject_procedures
            for procedure in procedures_dict.get("subject_procedures", []):
                # Use JSON serialization for robust comparison
                procedure_json = json.dumps(procedure, sort_keys=True, default=str)
                if procedure_json not in seen_subject_procs:
                    seen_subject_procs.add(procedure_json)
                    all_subject_procedures.append(procedure)

            # Handle specimen_procedures
            for procedure in procedures_dict.get("specimen_procedures", []):
                procedure_json = json.dumps(procedure, sort_keys=True, default=str)
                if procedure_json not in seen_specimen_procs:
                    seen_specimen_procs.add(procedure_json)
                    all_specimen_procedures.append(procedure)

        merged["procedures"] = {
            "subject_procedures": all_subject_procedures,
            "specimen_procedures": all_specimen_procedures,
        }

        # Collect all acquisitions (one per record/data asset)
        acquisitions = []
        for record in records:
            if "acquisition" in record:
                acquisitions.append(record["acquisition"])

        merged["acquisitions"] = acquisitions

        return merged

    def _on_load(self):
        """Check subject_id after page loads and URL is available."""
        # Manually read from URL if not synced yet
        if not subject_settings.subject_id and "subject_id" in pn.state.location.query_params:
            subject_id_from_url = str(pn.state.location.query_params["subject_id"])
            subject_settings.subject_id = subject_id_from_url

    def _fetch_and_display(self, event):
        """Fetch subject data from DocDB and update view."""
        subject_id = subject_settings.subject_id

        if not subject_id:
            self.subject_view.subject_data = {}
            self.panel.loading = False
            return

        try:
            self.panel.loading = True

            # Query DocDB by subject.subject_id
            records = self.client.retrieve_docdb_records(
                filter_query={"subject.subject_id": subject_id},
                projection={
                    "subject": 1,
                    "procedures": 1,
                    "acquisition": 1,
                    "data_description": 1,
                },
            )

            if records:
                # Merge all records, combining unique procedures and all acquisitions
                merged_data = self._merge_records(records)
                self.subject_view.subject_data = merged_data
                self.panel.loading = False
            else:
                # Show "no records found" message in the main panel
                self.panel.clear()
                self.panel.append(
                    pn.pane.Alert(
                        f"## No records found\n\nNo records found for subject **{subject_id}** in the database.",
                        alert_type="warning",
                        sizing_mode="stretch_width",
                    )
                )
                self.panel.loading = False
                return

        except Exception as e:
            # Show full error with stack trace in the main panel
            error_trace = traceback.format_exc()
            self.panel.clear()
            self.panel.append(
                pn.pane.Alert(
                    f"## Error Loading Subject {subject_id}\n\n"
                    f"**Error:** {str(e)}\n\n"
                    f"### Stack Trace\n\n```\n{error_trace}\n```",
                    alert_type="danger",
                    sizing_mode="stretch_width",
                )
            )
            self.panel.loading = False

    def __panel__(self):
        return self.panel
