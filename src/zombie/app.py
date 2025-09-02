""" Zoomable Observatory for Multiscale Brain Investigation and Exploration """

import panel as pn
from hdmf_zarr import NWBZarrIO
import altair as alt
import pandas as pd


pn.extension('vega')
