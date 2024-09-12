# Build a single QCEvaluation panel
from zombie.s3 import SpikeSorting
from zombie.plotting.ecephys import raster_aggregated
import panel as pn
import json
import numpy as np

# Build one QC element
ss = SpikeSorting()

sx = ss.st()
clu = ss.clu()
locs = ss.locs()

sy = np.zeros_like(clu)

for uclu in np.unique(clu):
    index = np.where(clu == uclu)
    sy[index] = locs[uclu, 1]

dmap = raster_aggregated(sx, sy)
drift_map = pn.pane.Vega(dmap)


class Metric:

    def __init__(self, metric_data: dict):
        """_summary_"""
        self.raw_data = metric_data
        self.reference_img = None

    @property
    def name(self):
        return self.raw_data["name"]

    @property
    def value(self):
        return self.raw_data["value"]

    @property
    def description(self):
        return self.raw_data["description"]

    @property
    def references(self):
        return self.raw_data["references"]

    def panel(self):
        """Build a Panel object representing this metric object

        Returns
        -------
        _type_
            _description_
        """
        if not self.reference_img and self.references:
            for ref in self.references:
                if ref == "ecephys-drift-map":
                    self.reference_img = ""
                else:
                    self.reference_img = f"Unable to parse {refer}"
        else:
            self.reference_img = "No references included"

        row = pn.Row(
            drift_map,
            self.metric_panel(),
            name=self.name,
        )
        return row

    def metric_panel(self):
        md = f"""
{self.description if self.description else "*no description provided*"}
"""
        if isinstance(self.value, bool):
            value_widget = pn.widgets.Checkbox(name=self.name)
        elif isinstance(self.value, str):
            value_widget = pn.widgets.TextInput(name=self.name)
        elif isinstance(self.value, float):
            value_widget = pn.widgets.FloatInput(name=self.name)
        elif isinstance(self.value, int):
            value_widget = pn.widgets.IntInput(name=self.name)
        elif isinstance(self.value, dict):
            value_widget = pn.widgets.JSONEditor(name=self.name)
        else:
            print(f"Error can't deal with type {type(self.value)}")

        value_widget.value = self.value
        pn.bind(self.value, value_widget)
        col = pn.WidgetBox(pn.pane.Markdown(md), value_widget)
        return col


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

        md = f"""
# {self.name}
<span style="font-size:16pt">Status: {self.overall_status_html} on **{self.overall_status_date}**</span>
"""
        header = pn.pane.Markdown(md)

        notes = pn.widgets.TextAreaInput(value=self.notes, placeholder="No notes provided")

        tabs = pn.Tabs()
        tabs.objects = objects

        col = pn.Column(header, notes, tabs)
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
