"""Settings that control the DocDB asset query"""

from panel.custom import PyComponent
import panel as pn
import param

from zombie_squirrel import unique_project_names


class QuerySettings(PyComponent):

    project_names = param.List(default=[])

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        print("Initializing QuerySettings")

        header = pn.pane.Markdown("### Query settings")

        self.project_selector = pn.widgets.MultiChoice.from_param(
            self.param.project_names,
            name="data_description.project_name",
            options=unique_project_names(),
        )

        pn.state.location.sync(self, parameters=["project_names"])
        self.project_selector.value = self.project_names

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
