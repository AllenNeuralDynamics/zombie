from datetime import datetime
import panel as pn
from panel.custom import PyComponent
import param


class SubjectInfoView(PyComponent):
    """Display subject metadata in a formatted markdown panel."""

    subject_data = param.Dict(default={})

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.info_pane = pn.pane.Markdown("No subject data loaded", sizing_mode="stretch_width")
        self.panel = pn.Column(
            self.info_pane,
            sizing_mode="stretch_width",
        )

    @param.depends("subject_data", watch=True)
    def _update_info(self):
        """Update the markdown display based on subject data."""
        if not self.subject_data:
            self.info_pane.object = "No subject data loaded"
            return

        # Extract key information
        subject = self.subject_data.get("subject", {})
        subject_id = subject.get("subject_id", "Unknown")
        subject_details = subject.get("subject_details", {})

        # Basic info
        dob = subject_details.get("date_of_birth", "Unknown")
        sex = subject_details.get("sex", "Unknown")
        genotype = subject_details.get("genotype", "Unknown")

        # Species and strain
        species = subject_details.get("species", {})
        species_name = species.get("name", "Unknown")
        strain = subject_details.get("strain", {})
        strain_name = strain.get("name", "Unknown")

        # Housing
        housing = subject_details.get("housing", {})
        cage_id = housing.get("cage_id", "Unknown")
        room_id = housing.get("room_id", "Unknown")

        # Calculate age if possible
        age_str = "Unknown"
        if dob != "Unknown":
            try:
                birth_date = datetime.fromisoformat(dob)
                today = datetime.now()
                age_days = (today - birth_date).days
                age_str = f"{age_days} days ({age_days // 7} weeks)"
            except:
                pass

        # Build markdown - compact format
        markdown = f"""
### Subject {subject_id}

**Born:** {dob} ({age_str})  
**Sex:** {sex} | **Species:** {species_name} | **Strain:** {strain_name}  
**Genotype:** {genotype}  
**Housing:** Cage {cage_id}, Room {room_id}
"""

        self.info_pane.object = markdown

    def __panel__(self):
        return self.panel
