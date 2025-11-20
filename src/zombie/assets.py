import panel as pn
from zombie_squirrel import asset_basics

df = asset_basics()


col = pn.Column(
    pn.widgets.Tabulator(df, header_filters=True, show_index=False)
)

col.servable(title="Asset Basics")
