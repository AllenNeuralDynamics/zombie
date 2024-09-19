# Searchbar
# Generates a Panel row object that integrates with DocDB to get the subject/session/date of a record
# Eventually we'll add an LLM summary of the
import panel as pn
import pandas as pd
import param
from datetime import datetime

from zombie.database import get_meta


asset_link_prefix = "http://localhost:5007/qc_asset_app?id="
qc_link_prefix = "http://localhost:5007/qc_app?id="


class SearchOptions(param.Parameterized):

    def __init__(self):
        """Initialize a search options object"""

        data = []
        meta_list = get_meta()

        self.shame = []

        for record in meta_list:
            record_split = record["name"].split("_")
            if len(record_split) >= 4:  # drop names that are junk

                if "qc_exists" in record and record["qc_exists"]:
                    status = record["qc_exists"]
                else:
                    status = "No QC"

                # check that the date parses
                date = record_split[2]
                try:
                    datetime.fromisoformat(date)
                except ValueError:
                    self.shame.append(record["name"])
                    continue

                r = {
                    "name": record["name"],
                    "modality": record_split[0],
                    "subject_id": record_split[1],
                    "date": record_split[2],
                    "status": status,
                    "asset_view": f'<a href="{asset_link_prefix}{record["_id"]}" target="_blank">link</a>',
                    "qc_view": f'<a href="{qc_link_prefix}{record["_id"]}" target="_blank">link</a>',
                }
                data.append(r)
            else:
                self.shame.append(record["name"])

        self.df = pd.DataFrame(
            data,
            columns=[
                "name",
                "modality",
                "subject_id",
                "date",
                "status",
                "asset_view",
                "qc_view",
            ],
        )

        self.df = self.df.sort_values(by="date", ascending=False)

        self._subject_ids = list(sorted(set(self.df["subject_id"].values)))
        self._subject_ids.insert(0, "")
        self._modalities = list(sorted(set(self.df["modality"].values)))
        self._modalities.insert(0, "")
        self._dates = list(sorted(set(self.df["date"].values)))
        self._dates.insert(0, "")

        self.active("", "", "")

    @property
    def subject_ids(self):
        return self._subject_ids

    @property
    def modalities(self):
        return self._modalities

    @property
    def dates(self):
        return self._dates

    def active(self, modality_filter, subject_filter, date_filter):
        df = self.df.copy()

        if modality_filter != "":
            df = df[df["modality"] == modality_filter]

        if subject_filter != "":
            df = df[df["subject_id"] == subject_filter]

        if date_filter != "":
            df = df[df["date"] == date_filter]

        # Keep a copy with the name field
        self.active_df = df.copy()

        df = df.drop(["name"], axis=1)

        df = df.rename(
            columns={
                "modality": "Modality",
                "subject_id": "Subject ID",
                "date": "Date",
                "status": "Status",
                "asset_view": "Asset View",
                "qc_view": "QC View",
            }
        )

        return df
    
    def active_names(self):
        return list(set(self.active_df["name"].values))

    def all_names(self):
        return list(set(self.df["name"].values))


options = SearchOptions()


class SearchView(param.Parameterized):
    modality_filter = param.ObjectSelector(default="", objects=options.modalities)
    subject_filter = param.ObjectSelector(default="", objects=options.subject_ids)
    date_filter = param.ObjectSelector(default="", objects=options.dates)

    def __init__(self, **params):
        super().__init__(**params)

    def _qc_color(self, v):
        """Re-color the QC field background

        Parameters
        ----------
        v : str
            QC status value

        Returns
        -------
        str
            CSS style string
        """
        if v == "No QC":
            return "background-color: yellow"
        elif v == "Pass":
            return "background-color: green"
        elif v == "Fail":
            return "background-color: red"
        elif v == "Pending":
            return "background-color: blue"

    @param.depends('modality_filter', 'subject_filter', 'date_filter', watch=True)
    def df_filtered(self):
        """Filter the options dataframe"""
        df_filtered = options.active(self.modality_filter, self.subject_filter, self.date_filter)

        return df_filtered.style.map(self._qc_color, subset=["Status"])


searchview = SearchView()
pn.state.location.sync(searchview, {
    'modality_filter': 'modality',
    'subject_filter': 'subject',
    'date_filter': 'date'
})

text_input = pn.widgets.AutocompleteInput(
    name="Search:",
    placeholder="Name/Subject/Modality/Date",
    options=options.active_names(),
    search_strategy="includes",
    min_characters=0,
    width=660,
)


def new_class(cls, **kwargs):
    "Creates a new class which overrides parameter defaults."
    return type(type(cls).__name__, (cls,), kwargs)


search_dropdowns = pn.Param(searchview, name="Filters", show_name=False,
                            default_layout=new_class(pn.GridBox, ncols=2),)

left_col = pn.Column(text_input, search_dropdowns)

dataframe_pane = pn.pane.DataFrame(searchview.df_filtered(),
                                   escape=False, sizing_mode="stretch_both", min_height=800, max_height=1200,
                                   index=False)


@pn.depends(searchview.param.modality_filter, searchview.param.subject_filter, searchview.param.date_filter, watch=True)
def update_dataframe(*events):
    text_input.options = options.active_names()
    dataframe_pane.object = searchview.df_filtered()
    dataframe_pane.index = False


md = """
# Allen Institute for Neural Dynamics - QC Portal
This portal allows you to search all existing metadata and explore the **quality control** file. Open the asset view to see the raw and derived assets related to a single record. Open the QC view to explore the quality control object for that record.
"""
header = pn.pane.Markdown(md)

col = pn.Column(header, left_col, dataframe_pane, min_width=660)

display = pn.Row(pn.HSpacer(), col, pn.HSpacer())

# hall_of_shame = pn.Card(", ".join(options.shame), title="Hall of shame:")

display.servable(title="AIND QC - Portal")
