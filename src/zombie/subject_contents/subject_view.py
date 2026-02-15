import panel as pn
from panel.custom import PyComponent
import param

from zombie.subject_contents.timeline_view import TimelineView
from zombie.subject_contents.info_view import SubjectInfoView
from zombie.layout import OUTER_STYLE


class SubjectView(PyComponent):
    """Main view combining subject information and timeline."""
    
    subject_data = param.Dict(default={})
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
        # Create child views
        self.timeline_view = TimelineView()
        self.info_view = SubjectInfoView()
        
        # Build layout with styling
        self.panel = pn.Column(
            pn.Column(
                self.info_view,
                self.timeline_view,
                sizing_mode="stretch_both",
                styles=OUTER_STYLE,
            ),
            sizing_mode="stretch_both",
        )
    
    @param.depends("subject_data", watch=True)
    def _update_views(self):
        """Propagate subject data to child views."""
        self.timeline_view.subject_data = self.subject_data
        self.info_view.subject_data = self.subject_data
    
    def __panel__(self):
        return self.panel
