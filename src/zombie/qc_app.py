# QC TEST APP

import altair as alt
import panel as pn
import param

# from zombie.search import search_bar
from zombie.qc_eval_panel import QualityControl

alt.data_transformers.disable_max_rows()
pn.extension("vega", "ace", "jsoneditor")
# pn.state.template.title = "AIND QC"


# State sync
class Settings(param.Parameterized):
    name = param.String(default="ecephys_718481_2024-06-04_10-33-39")


settings = Settings()
pn.state.location.sync(settings, {"name": "session_name"})

qc_panel = QualityControl(name=settings.name)

qc_panel.panel().servable(title="AIND QC - View")
