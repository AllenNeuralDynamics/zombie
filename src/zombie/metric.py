from zombie.s3 import SpikeSorting
from zombie.plotting.ecephys import raster_aggregated

import panel as pn
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
        """Build a Metric object, should only be called by Evaluation()

        Parameters
        ----------
        evaluation_data : dict
            See aind_data_schema.core.quality_control Evaluation
        """
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
                    self.reference_img = (
                        f"Unable to parse {self.reference_img}"
                    )
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
