# Searchbar
# Generates a Panel row object that integrates with DocDB to get the subject/session/date of a record
# Eventually we'll add an LLM summary of the
import panel as pn
import pandas as pd
import param

from zombie.database import get_meta


asset_link_prefix = "http://localhost:5007/qc_asset_app?id="
qc_link_prefix = "http://localhost:5007/qc_app?id="


class SearchOptions(param.Parameterized):

    def __init__(self):
        """Initialize a search options object"""

        data = []
        meta_list = get_meta()

        for record in meta_list:
            record_split = record["name"].split("_")
            if len(record_split) == 4:

                if "qc_exists" in record:
                    status = record["qc_exists"]
                else:
                    status = "No QC"

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

        self._subject_ids = list(sorted(set(self.df["subject_id"].values)))
        self._subject_ids.insert(0, "")
        self._modalities = list(sorted(set(self.df["modality"].values)))
        self._modalities.insert(0, "")
        self._dates = list(sorted(set(self.df["date"].values)))
        self._dates.insert(0, "")

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
        df = df.drop(["name"], axis=1)

        if modality_filter != "":
            df = df[df["modality"] == modality_filter]

        if subject_filter != "":
            df = df[df["subject_id"] == subject_filter]

        if date_filter != "":
            df = df[df["date"] == date_filter]

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

    def all(self):
        return list(set(self.df["name"].values))


options = SearchOptions()


class SearchView(param.Parameterized):
    modality_filter = param.ObjectSelector(default="", objects=options.modalities)
    subject_filter = param.ObjectSelector(default="", objects=options.subject_ids)
    date_filter = param.ObjectSelector(default="", objects=options.dates)

    def __init__(self, **params):
        super().__init__(**params)

    @param.depends('modality_filter', 'subject_filter', 'date_filter', watch=True)
    def df_filtered(self):
        """Filter the options dataframe"""
        df_filtered = options.active(self.modality_filter, self.subject_filter, self.date_filter)

        # add colors
        def color(v):
            if v == "No QC":
                return "background-color: yellow"
            else:
                return "background-color: green"

        return df_filtered.style.map(color, subset=["Status"])


searchview = SearchView()


text_input = pn.widgets.AutocompleteInput(
    name="Search:",
    placeholder="Name/Subject/Experiment Type/Date",
    options=options.all(),
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
                                   escape=False, sizing_mode="stretch_both", max_height=1200, index=False)


@pn.depends(searchview.param.modality_filter, searchview.param.subject_filter, searchview.param.date_filter, watch=True)
def update_dataframe(*events):
    dataframe_pane.object = searchview.df_filtered()


col = pn.Column(left_col, dataframe_pane, min_width=660)

display = pn.Row(pn.HSpacer(), col, pn.HSpacer())
display.servable(title="AIND QC - Browse")
