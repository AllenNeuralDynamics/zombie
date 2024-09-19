# QC TEST APP

import altair as alt
import panel as pn
import param
alt.data_transformers.disable_max_rows()
# from zombie.search import search_bar
from zombie.qc_eval_panel import QualityControl

alt.data_transformers.disable_max_rows()
pn.extension("vega", "ace", "jsoneditor")
# pn.state.template.title = "AIND QC"


# State sync
class Settings(param.Parameterized):
    id = param.String(default="33e427dd-1dd8-4062-abb4-0a82d5fc5def")


settings = Settings()
pn.state.location.sync(settings, {"id": "id"})


# def set_submit


qc_panel = QualityControl(id=settings.id)

qc_panel.panel().servable(title="AIND QC - View")
