# Searchbar
# Generates a Panel row object that integrates with DocDB to get the subject/session/date of a record
# Eventually we'll add an LLM summary of the
import panel as pn
import pandas as pd

from zombie.database import get_all


class Record:

    def __init__(self, name: str, subject_id: str, modality: str, date: str):
        self.name = name
        self.subject_id = subject_id
        self.modality = modality
        self.date = date


link = "http://localhost:5006/qc_test?session_name=ecephys_718481_2024-06-04_10-33-39"


class SearchOptions:

    def __init__(self):
        """Initialize a search options object"""

        data = []
        for record in get_all():
            record_split = record["name"].split("_")

            if "quality_control" in record:
                status = record["quality_control"]["overall_status"]
            else:
                status = "No QC"

            r = {
                "name": record["name"],
                "modality": record_split[0],
                "subject_id": record_split[1],
                "date": record_split[2],
                "status": status,
                "view": f'<a href="{link}" target="_blank">link</a>',
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
                "view",
            ],
        )

    def select(self, event):
        pass

    def active(self):
        df = self.df.drop("name", axis=1)
        df = df.rename(
            columns={
                "modality": "Modality",
                "subject_id": "Subject ID",
                "date": "Date",
                "status": "Status",
                "view": "QC View",
            }
        )

        def color(v):
            if v == "No QC":
                return "background-color: yellow"
            else:
                return "background-color: green"

        return df.style.applymap(color, subset=["Status"])

    def all(self):
        return list(set(self.df["name"].values))

    def subject_ids(self):
        return list(set(self.df["subject_id"].values))

    def modalities(self):
        return list(set(self.df["modality"].values))

    def dates(self):
        return list(set(self.df["date"].values))


options = SearchOptions()

text_input = pn.widgets.AutocompleteInput(
    name="Search:",
    placeholder="Name/Subject/Experiment Type/Date",
    options=options.all(),
    search_strategy="includes",
    min_characters=0,
)

select_subject = pn.widgets.Select(
    name="Subject ID", options=options.subject_ids(), width=100
)

select_experiment = pn.widgets.Select(
    name="Modality", options=options.modalities(), width=100
)

select_date = pn.widgets.Select(
    name="Date", options=options.dates(), width=100
)


def record_selected(record: Record):
    select_subject.value = record.subject_id
    select_experiment.value = record.modality
    select_date.value = record.date


def subject_id_selected(subject_id: str):
    pass


# Implement by-directional updates:
# if you select a record, update all the dropdowns to match
# if you


text_input.param.watch(options.select, "value")


def search_bar():
    search_dropdowns = pn.Row(select_experiment, select_subject, select_date)

    #     summary = pn.pane.Markdown(
    #         """
    # **Summary**
    #                                """
    #     )

    left_col = pn.Column(text_input, search_dropdowns)
    # right_col = pn.Column(summary)

    # bar = pn.Row(left_col, right_col, height=200)

    return left_col


df_widget = pn.pane.DataFrame(
    options.active(), escape=False, sizing_mode="stretch_both", max_height=1200
)
# df_widget.disabled = True

col = pn.Column(search_bar(), df_widget)

display = pn.Row(pn.HSpacer(), col, pn.HSpacer())
display.servable(title="AIND QC - Browse")
