from panel.custom import PyComponent
import panel as pn

from zombie.app_contents.space_view import SpaceView
from zombie.app_contents.time_view import TimeView
from zombie.app_contents.data_view import DataView

from zombie.settings.settings_view import settings_view


class MainView(PyComponent):

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # Import modal and create gear button
        self.gear_button = settings_view.panel.create_button(
            action="toggle",
            icon="settings",
            # button_type="primary",
            width=32,
            height=32,
        )

        time_view = TimeView()
        space_view = SpaceView()
        
        # Data views container with flex layout
        self.data_views = []
        self.data_views_container = pn.FlexBox(sizing_mode="stretch_width", styles={"gap": "10px"})
        
        # Add first data view
        self._add_data_view(time_view)
        
        # Add/Remove buttons
        add_button = pn.widgets.Button(name="+ Add Data View", button_type="success", width=150)
        add_button.on_click(lambda event: self._add_data_view(time_view))
        
        data_view_controls = pn.Row(add_button, sizing_mode="fixed")

        self.panel = pn.Column(
            pn.Row(time_view, self.gear_button),
            data_view_controls,
            self.data_views_container,
            pn.Row(space_view),
            settings_view,
        )

    def _add_data_view(self, time_view):
        """Add a new data view to the container"""
        data_view = DataView()
        
        # Link time view selection to this data view
        time_view.param.watch(lambda event: setattr(data_view, "time_selection", event.new), "selection")
        
        # Create remove button for this view
        remove_button = pn.widgets.Button(name="✕", button_type="danger", width=40, height=40)
        view_index = len(self.data_views)
        remove_button.on_click(lambda event: self._remove_data_view(view_index))
        
        # Wrap in a card with remove button
        view_card = pn.Card(
            data_view,
            header=pn.Row(pn.pane.Markdown("**Data View**"), pn.Spacer(), remove_button, sizing_mode="stretch_width"),
            sizing_mode="stretch_width",
            styles={"border": "1px solid #ddd", "border-radius": "5px"},
        )
        
        self.data_views.append({"view": data_view, "card": view_card})
        self.data_views_container.append(view_card)
    
    def _remove_data_view(self, index):
        """Remove a data view from the container"""
        if len(self.data_views) > 1 and index < len(self.data_views):
            view_info = self.data_views.pop(index)
            self.data_views_container.remove(view_info["card"])

    def __panel__(self):
        return self.panel
