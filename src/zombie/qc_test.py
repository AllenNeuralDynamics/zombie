# QC TEST APP

import altair as alt
import panel as pn
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

from zombie.s3 import SpikeSorting
from zombie.plots import raster_aggregated
from zombie.utils import bincount2D

alt.data_transformers.disable_max_rows()
pn.extension('vega', template='fast')
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

pn.Row(left_col, right_col).servable()
