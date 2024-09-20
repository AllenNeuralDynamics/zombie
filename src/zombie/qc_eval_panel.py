# Build a single QCEvaluation panel
import panel as pn
from zombie.metric import Metric
from zombie.database import qc_from_id, qc_update_to_id
from zombie.utils import md_style


class Evaluation:

    def __init__(self, parent, evaluation_data: dict):
        """Build an Evaluation object, should only be called by QualityControl()

        Parameters
        ----------
        evaluation_data : dict
            See aind_data_schema.core.quality_control Evaluation
        """
        self.parent = parent
        self.update(evaluation_data)

    def update(self, evaluation_data: dict):
        self.raw_data = evaluation_data

        self.name = self.raw_data["evaluation_name"]
        self.description = (
            self.raw_data["evaluation_description"]
            if self.raw_data["evaluation_description"]
            else None
        )
        self.evaluator = self.raw_data["evaluator"]
        self.date = self.raw_data["evaluation_date"]
        self.status = self.raw_data["stage_status"]
        self.notes = self.raw_data["notes"] if "notes" in self.raw_data else None

        self.metrics = []
        for metric_data in self.raw_data["qc_metrics"]:
            self.metrics.append(Metric(metric_data))

    def set_status(self, event):
        self.raw_data["stage_status"] = event.new
        self.parent.set_dirty()

    def set_notes(self, event):
        self.raw_data["notes"] = event.new
        self.parent.set_dirty()

    def panel(self):
        """Build a Panel object representing this Evaluation"""
        objects = []
        for metric in self.metrics:
            objects.append(metric.panel())

        md = f"""
{md_style(12, self.description if self.description else "*no description provided*")}
{md_style(8, "Current state:")}
{md_style(8, f"Status **{self.status}** set by **{self.evaluator}** on **{self.date}**")}
{md_style(8, f"Evaluation for **{self.raw_data["evaluation_modality"]["name"]}** **{self.raw_data["evaluation_stage"]}** stage")}
{md_style(8, f"Notes: {self.notes if self.notes else "*no notes provided*"}")}
{md_style(8, f"Contains **{len(self.raw_data["qc_metrics"])}** metrics.")}
"""
        
        header = pn.pane.Markdown(md)

        # Set up the widgetbox and set param watches
        status_selector = pn.widgets.Select(
            name="Status", options=["Fail", "Pending", "Pass"]
        )
        status_selector.value = self.status
        notes = pn.widgets.TextAreaInput(
            value=self.notes, placeholder="no notes provided"
        )

        status_selector.param.watch(self.set_status, "value")
        notes.param.watch(self.set_notes, "value")

        controls = pn.WidgetBox(status_selector, notes)

        header_row = pn.Row(header, pn.HSpacer(width=50), controls)

        accordion = pn.Accordion()
        accordion.objects = objects
        accordion.active = [0]

        col = pn.Column(header_row, accordion, name=self.name)

        return col


class QualityControl:

    def __init__(self, id):
        """_summary_"""
        self.id = id

        self.submit_button = pn.widgets.Button(
            name="Submit changes", button_type="success"
        )
        self.submit_button.disabled = True
        pn.bind(self.submit_changes, self.submit_button, watch=True)

        self.get_data()

    def get_data(self):
        json_data = qc_from_id(self.id)

        self.name = json_data["name"]
        self.raw_data = json_data["quality_control"]

        self.evaluations = []
        for evaluation_data in self.raw_data["evaluations"]:
            self.evaluations.append(
                Evaluation(parent=self, evaluation_data=evaluation_data)
            )

        self.dirty = False

    def set_dirty(self):
        self.dirty = True
        self.submit_button.disabled = False

    def set_status(self, event):
        self.raw_data["overall_status"] = event.new
        self.set_dirty()

    def submit_changes(self, *event):
        qc_update_to_id(self.id, self.raw_data)
        print("Submitted")

    def panel(self):
        """Build a Panel object representing this QC action"""
        objects = []
        for evaluation in self.evaluations:
            objects.append(evaluation.panel())

        # build the header
        md = f"""
# Quality control for {self.name}
"""
        header = pn.pane.Markdown(md)

        # build the display box: this shows the current state in DocDB of this asset
        state_md = f"""
<span style="font-size:14pt">Current state:</span>
<span style="font-size:12pt">Status: {self.overall_status_html} on **{self.overall_status_date}**</span>
<span style="font-size:12pt">Notes: {self.notes if self.notes else "*no notes provided*"}</span>
<span style="font-size:12pt">Contains {len(self.evaluations)} evaluations.</span>
"""

        state_pane = pn.pane.Markdown(state_md, width=500, height=120)

        # build the widget box
        status = pn.widgets.Select(value=self.overall_status)
        status.options = ["Fail", "Pending", "Pass"]
        notes = pn.widgets.TextAreaInput(
            value=self.notes, placeholder="no notes provided"
        )

        status.param.watch(self.set_status, "value")
        notes.param.watch(self.set_dirty, "value")

        box = pn.WidgetBox(
            pn.Column(status, notes, width=480, height=120),
            name="Settings:",
        )

        # combine and then put in a column, with header
        qc_row = pn.Row(state_pane, box)

        quality_control_pane = pn.Column(header, qc_row)

        # button
        header_row = pn.Row(
            quality_control_pane, pn.HSpacer(), self.submit_button, width=1000
        )

        tabs = pn.Tabs()
        tabs.objects = objects

        col = pn.Column(header_row, pn.layout.Divider(), tabs, min_width=1000)

        body = pn.Row(pn.HSpacer(), col, pn.HSpacer())
        return body

    def dump(self):
        """Return this quality_control.json object back to it's JSON format"""

    @property
    def overall_status(self):
        return self.raw_data["overall_status"]

    @property
    def overall_status_html(self):
        status = self.raw_data["overall_status"]
        if status == "Pass":
            color = "green"
        elif status == "Pending":
            color = "blue"
        else:
            color = "yellow"

        return f'<span style="color:{color};">{status}</span>'

    @property
    def overall_status_date(self):
        return self.raw_data["overall_status_date"]

    @property
    def notes(self):
        return self.raw_data["notes"]
