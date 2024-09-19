import param
import panel as pn
import pandas as pd

from zombie.database import get_name_from_id, get_assets_by_name


class AssetHistory(param.Parameterized):
    id = param.String(default="")

    def __init__(self, **params):
        super().__init__(**params)

    @pn.depends('id', watch=True)
    def update(self):
        self.asset_name = get_name_from_id(self.id)

        self.records = get_assets_by_name(self.asset_name)


asset_history = AssetHistory()
pn.state.location.sync(asset_history, {
    'id': 'id',
})

if asset_history.id == "":
    error_string = "\nAn ID must be provided as a query string. Please go back to the portal and choose an asset from the list."
else:
    error_string = ""

md = f"""
# QC Portal - Asset View
This view shows the history of a single asset record back to its original raw dataset along with any derived assets. Select a single asset to view the quality control object associated with that asset.
{error_string}
"""

header = pn.pane.Markdown(md)

json = pn.pane.JSON(asset_history.records)

col = pn.Column(
    header,
    json,
    min_width=660
)

# Create the layout
display = pn.Row(pn.HSpacer(), col, pn.HSpacer())

display.servable()
