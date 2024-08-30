# Searchbar
# Generates a Panel row object that integrates with DocDB to get the subject/session/date of a record
# Eventually we'll add an LLM summary of the
import panel as pn

from zombie.docdb import get_all


class Record:

    def __init__(self, name: str, subject_id: str, modality: str, date: str):
        self.name = name
        self.subject_id = subject_id
        self.modality = modality
        self.date = date


class SearchOptions:

    def __init__(self):
        """Initialize a search options object"""

        self.records = []

        for record in get_all():
            r = Record(
                name=record["name"],
                subject_id=record["subject"]["subject_id"],
                modality=record["name"].split("_")[0],
                date=record["name"].split("_")[2],
            )
            self.records.append(r)

        self.selected = self.records[0]

    def active(self):
        return self.selected

    def select(self, event):
        record = next((r for r in self.records if r.name == text_input.value), None)
        self.selected = record
        record_selected(self.selected)

    def all(self):
        return list(set([record.name for record in self.records]))

    def subject_ids(self):
        return list(set([record.subject_id for record in self.records]))

    def modalities(self):
        return list(set([record.modality for record in self.records]))

    def dates(self):
        return list(set([record.date for record in self.records]))


options = SearchOptions()

text_input = pn.widgets.AutocompleteInput(
    name="Search:",
    placeholder="Name/Subject/Experiment Type/Date",
    options=options.all(),
    search_strategy="includes",
)

select_subject = pn.widgets.Select(
    name="Subject ID", options=options.subject_ids(), width=100
)

select_experiment = pn.widgets.Select(
    name="Experiment type", options=options.modalities(), width=100
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
    search_dropdowns = pn.Row(select_subject, select_experiment, select_date)

    summary = pn.pane.Markdown(
        """
**Summary**
                               """
    )

    left_col = pn.Column(text_input, search_dropdowns)
    right_col = pn.Column(summary)

    bar = pn.Row(left_col, right_col, height=200)

    return bar
