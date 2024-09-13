# Build a single QCEvaluation panel
import panel as pn
import json
from zombie.metric import Metric


class Evaluation:

    def __init__(self, evaluation_data: dict):

        self.raw_data = evaluation_data

        self.name = self.raw_data["evaluation_name"]
        self.description = (
            self.raw_data["evaluation_description"]
            if self.raw_data["evaluation_description"]
            else None
        )
        self.evaluator = self.raw_data["evaluator"]
        self.date = self.raw_data["evaluation_date"]

        self.metrics = []
        for metric_data in self.raw_data["qc_metrics"]:
            self.metrics.append(Metric(metric_data))

    def panel(self):
        """Build a Panel object representing this Evaluation"""
        objects = []
        for metric in self.metrics:
            objects.append(metric.panel())

        md = f"""
{self.description if self.description else "*no description provided*"}
Evaluated by **{self.evaluator}** on **{self.date}**
"""
        header = pn.pane.Markdown(md)

        accordion = pn.Accordion()
        accordion.objects = objects
        accordion.active = [0]

        col = pn.Column(header, accordion, name=self.name)

        return col


class QualityControl:

    def __init__(self, name):
        """_summary_"""
        with open("files/metadata.nd.json", "r") as file:
            json_data = json.load(file)

        self.name = name
        self.raw_data = json_data["quality_control"]

        self.evaluations = []
        for evaluation_data in self.raw_data["evaluations"]:
            self.evaluations.append(Evaluation(evaluation_data))

    def panel(self):
        """Build a Panel object representing this QC action"""
        objects = []
        for evaluation in self.evaluations:
            objects.append(evaluation.panel())

        # build the header
        md = f"""
# {self.name}
<span style="font-size:16pt">Status: {self.overall_status_html} on **{self.overall_status_date}**</span>
"""
        header = pn.pane.Markdown(md)
        
        # build the widget box
        status = pn.widgets.Select(value=self.overall_status)
        status.options = ["Fail", "Pending", "Pass"]
        notes = pn.widgets.TextAreaInput(value=self.notes, placeholder="No notes provided")
        box = pn.WidgetBox(pn.Row(status, notes), name="Settings:")

        left_col = pn.Column(header, box)

        # button
        submit_button = pn.widgets.Button(name="Submit changes", button_type="success")
        submit_button.disabled = True
        header_row = pn.Row(left_col, pn.HSpacer(), submit_button)

        tabs = pn.Tabs()
        tabs.objects = objects

        col = pn.Column(header_row, pn.layout.Divider(), tabs)
        return col

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

        return f"<span style=\"color:{color};\">{status}</span>"

    @property
    def overall_status_date(self):
        return self.raw_data["overall_status_date"]

    @property
    def notes(self):
        return self.raw_data["notes"]
