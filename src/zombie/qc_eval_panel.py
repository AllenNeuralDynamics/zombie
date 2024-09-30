# Build a single QCEvaluation panel
import panel as pn
import param
import json
from zombie.qc.metric import QCMetricPanel
from zombie.database import qc_from_id, qc_update_to_id
from zombie.utils import md_style, status_html
from aind_data_schema.core.quality_control import QualityControl, QCEvaluation


class QCEvalPanel:

    def __init__(self, parent, evaluation_data: dict):
        """Build an Evaluation object, should only be called by QualityControl()

        Parameters
        ----------
        evaluation_data : dict
            See aind_data_schema.core.quality_control Evaluation
        """
        self.parent = parent
        self.update(evaluation_data)

    def update(self, evaluation_data: QCEvaluation):
        self.data = evaluation_data

        self.metrics = []
        for qc_metric in self.data.qc_metrics:
            self.metrics.append(QCMetricPanel(self.parent, qc_metric))

    def set_notes(self, event):
        self.data.notes = event.new
        self.parent.set_dirty()

    def panel(self):
        """Build a Panel object representing this Evaluation"""
        objects = []
        for metric in self.metrics:
            objects.append(metric.panel())

        allow_failing_str = "Metrics are allowed to fail in this evaluation." if self.data.allow_failed_metrics else ""

        md = f"""
{md_style(12, self.data.evaluation_description if self.data.evaluation_description else "*no description provided*")}
{md_style(8, f"Current state: **{status_html(self.data.evaluation_status)}** set by **{self.data.evaluation_status.evaluator}** on **{self.data.evaluation_status.timestamp}**")}
{md_style(8, f"Contains **{len(self.data.qc_metrics)}** metrics. {allow_failing_str}")}
"""
        
        header = pn.pane.Markdown(md)

        notes = pn.widgets.TextAreaInput(
            name="Notes:",
            value=self.data.notes, placeholder="no notes provided"
        )

        notes.param.watch(self.set_notes, "value")

        header_row = pn.Row(header, notes)

        accordion = pn.Accordion(*objects, sizing_mode='stretch_width')
        accordion.active = [0]

        col = pn.Column(header_row, accordion, name=self.data.evaluation_name)

        return col


class QCPanel:
    modality_filter = param.String(default="All")
    stage_filter = param.String(default="All")

    def __init__(self, id):
        """_summary_"""
        self.id = id

        self.submit_button = pn.widgets.Button(
            name="Submit changes", button_type="success",
        )
        pn.bind(self.submit_changes, self.submit_button, watch=True)

        self.hidden_html = pn.pane.HTML("")
        self.hidden_html.visible = False

        self.update()

    def update(self):
        self.get_data()
        self.submit_button.disabled = True

    def get_data(self):
        json_data = qc_from_id(self.id)

        self.name = json_data["name"]
        try:
            self.data = QualityControl.model_validate_json(json.dumps(json_data["quality_control"]))
        except Exception as e:
            self.data = None
            print(f"QC object failed to validate: {e}")

        self.evaluations = []
        for evaluations in self.data.evaluations:
            self.evaluations.append(
                QCEvalPanel(parent=self, evaluation_data=evaluations)
            )

        self.dirty = False

    def set_dirty(self, *event):
        self.dirty = True
        self.submit_button.disabled = False

    def submit_changes(self, *event):
        qc_update_to_id(self.id, self.data)
        self.submit_button.disabled = True
        self.hidden_html.object = "<script>window.location.reload();</script>"

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
        # if any evaluations are failing, we'll show a warning
        failing_eval_str = ""

        state_md = f"""
<span style="font-size:14pt">Current state:</span>
<span style="font-size:12pt">Status: {status_html(self.data.overall_status)} on **{self.data.overall_status.timestamp}**</span>
<span style="font-size:12pt">Contains {len(self.evaluations)} evaluations. {failing_eval_str}</span>
"""

        state_pane = pn.pane.Markdown(state_md)

        notes_box = pn.widgets.TextAreaInput(name='Notes:', value=self.data.notes, placeholder="no notes provided")
        notes_box.param.watch(self.set_dirty, "value")

        # state row
        state_row = pn.Row(state_pane, notes_box)
        quality_control_pane = pn.Column(header, state_row)

        # button
        header_row = pn.Row(
            quality_control_pane, pn.HSpacer(), self.submit_button
        )

        tabs = pn.Tabs(sizing_mode='stretch_width')
        tabs.objects = objects

        col = pn.Column(header_row, pn.layout.Divider(), tabs, self.hidden_html)

        body = col
        return body

    def dump(self):
        """Return this quality_control.json object back to it's JSON format"""
