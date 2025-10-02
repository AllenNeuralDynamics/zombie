"""Settings that control the DocDB asset query"""

from panel.custom import PyComponent
import panel as pn

from zombie.data.docdb.utils import get_unique_project_names


class QuerySettings(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing QuerySettings")

        header = pn.pane.Markdown("### Query settings")

        self.project_selector = pn.widgets.MultiChoice(
            name="data_description.project_name",
            options=get_unique_project_names(),
        )

        self.panel = pn.Column(
            header,
            self.project_selector,
        )

    def query(self):
        """Return the current query as a dictionary."""
        return {"data_description.project_name": {"$in": self.project_selector.value}}

    def __panel__(self):

        return self.panel


query_settings = QuerySettings()
