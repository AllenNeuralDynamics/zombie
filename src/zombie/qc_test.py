# QC TEST APP

import altair as alt
import panel as pn
import numpy as np

from zombie.search import search_bar
from zombie.s3 import SpikeSorting
from zombie.plots import raster_aggregated

alt.data_transformers.disable_max_rows()
pn.extension("vega", template="fast")
pn.state.template.title = "AIND Quality Control"


ss = SpikeSorting()

sx = ss.st()
clu = ss.clu()
locs = ss.locs()

sy = np.zeros_like(clu)

for uclu in np.unique(clu):
    index = np.where(clu == uclu)
    sy[index] = locs[uclu, 1]

dmap = raster_aggregated(sx, sy)

# left_col = pn.Column(drift_map(sx, sy))
left_col = pn.Column(dmap)
right_col = pn.Column("TODO")

metric_row = pn.Row(left_col, right_col, width=800)

search_bar().servable()

accordion = pn.Accordion(
    ("Metric _no_name_", metric_row), active=[0], width=1000
)


accordion.servable()
