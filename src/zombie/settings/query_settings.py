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

        # self.project_selector.param.watch(self._on_project_change, 'value')

        self.panel = pn.Column(
            header,
            self.project_selector,
        )
    
    # def _on_project_change(self, event):
    #     """Handle changes in the selected projects."""
    #     self.callback(event.new)
    #     print(f"Selected projects changed to: {event.new}")
    #     # Here you would add logic to handle the change in selected projects.
    #     # For example, you might want to update other settings based on the selected projects.

    def __panel__(self):

        return self.panel


query_settings = QuerySettings()
