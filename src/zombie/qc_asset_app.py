import param
import panel as pn
from datetime import datetime
import pandas as pd
import altair as alt

from zombie.database import get_name_from_id, get_assets_by_name
from zombie.utils import QC_LINK_PREFIX, qc_color

alt.data_transformers.disable_max_rows()
pn.extension("vega", "ace", "jsoneditor")

type_colors = {"raw": "yellow", "sorted-ks25": "blue", "nwb": "green"}


class AssetHistory(param.Parameterized):
    id = param.String(default="")

    def __init__(self, **params):
        super().__init__(**params)
        self.has_id = False

    @pn.depends("id", watch=True)
    def update(self):
        self.has_id = True

        self.asset_name = get_name_from_id(self.id)

        self._records = get_assets_by_name(self.asset_name)

        self.parse_records()

    @property
    def records(self):
        if self.has_id:
            return self._records
        else:
            return {}

    def parse_records(self):
        """Go through the records, pulling from the name to figure out the order of events

        If the input_data_name field is in data_description, we can also use that first
        """
        if not self.has_id:
            return

        data = []

        # [TODO] this is designed as-is because the current metadata records are all missing the input_data_name field, unfortunately
        for record in self._records:
            name_split = record["name"].split("_")

            if len(name_split) == 4:
                # raw asset
                modality = name_split[0]
                subject_id = name_split[1]
                date = name_split[2]
                time = name_split[3]
                type_label = "raw"
            elif len(name_split) == 7:
                # derived asset
                modality = name_split[0]
                subject_id = name_split[1]
                date = name_split[5]
                time = name_split[6]
                type_label = name_split[4]

            if "qc_exists" in record and record["qc_exists"]:
                status = record["qc_exists"]
            else:
                status = "No QC"

            raw_date = datetime.strptime(f"{date}_{time}", "%Y-%m-%d_%H-%M-%S")

            qc_link = f'<a href="{QC_LINK_PREFIX}{record["_id"]}" target="_blank">link</a>'

            data.append(
                {
                    "name": record["name"],
                    "modality": modality,
                    "subject_id": subject_id,
                    "timestamp": pd.to_datetime(raw_date),
                    "type": type_label,
                    "status": status,
                    "qc_view": qc_link,
                    "id": record["_id"],
                }
            )

        self.df = pd.DataFrame(
            data,
            columns=[
                "name",
                "modality",
                "subject_id",
                "timestamp",
                "type",
                "status",
                "qc_view",
                "id",
            ],
        )
        self.df = self.df.sort_values(by="timestamp", ascending=False)

    def asset_history_panel(self):
        """Create a plot showing the history of this asset, showing how assets were derived from each other"""
        if not self.has_id:
            return "No ID is set"

        chart = (
            alt.Chart(self.df)
            .mark_bar()
            .encode(
                x=alt.X("timestamp:T", title="Time"),
                y=alt.Y("count():Q", title="Count"),
                tooltip=["name", "modality", "subject_id", "timestamp"],
                color=alt.Color("type:N"),
            )
            .properties(width=600, height=300, title="Asset history")
        )

        return pn.pane.Vega(chart)

    def asset_history_df(self):
        """Todo"""
        if not self.has_id:
            return pd.DataFrame()

        df = self.df.copy()

        df = df.drop(["name", "id"], axis=1)

        df = df.rename(
            columns={
                "name": "Name",
                "modality": "Modality",
                "subject_id": "Subject ID",
                "timestamp": "Date",
                "type": "Type",
                "status": "Status",
                "qc_view": "QC View",
            }
        )
        return df.style.map(qc_color, subset=["Status"])


asset_history = AssetHistory()
pn.state.location.sync(
    asset_history,
    {
        "id": "id",
    },
)

if asset_history.id == "":
    error_string = "\n## An ID must be provided as a query string. Please go back to the portal and choose an asset from the list."
else:
    error_string = ""

md = f"""
# QC Portal - Asset View
This view shows the history of a single asset record, back to its original raw dataset along with any derived assets. Select a single asset to view the quality control object associated with that asset.
{error_string}
"""

header = pn.pane.Markdown(md, max_width=660)

asset_history.parse_records()

chart = asset_history.asset_history_panel()
dataframe = pn.pane.DataFrame(
    asset_history.asset_history_df(), index=False, escape=False
)
json_pane = pn.pane.JSON(asset_history.records)

col = pn.Column(
    header,
    chart,
    dataframe,
    json_pane,
    min_width=660,
)

# Create the layout
display = pn.Row(pn.HSpacer(), col, pn.HSpacer())

display.servable(title="AIND QC - Asset")
