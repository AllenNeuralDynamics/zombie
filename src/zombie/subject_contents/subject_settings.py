"""Settings for subject viewer"""

import param
import panel as pn


class SubjectSettings(param.Parameterized):
    """Settings that sync subject_id with URL."""
    
    subject_id = param.String(default="", doc="Subject ID to load from DocDB")
    
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        
        # Sync subject_id with URL
        pn.state.location.sync(self, {"subject_id": "subject_id"})


subject_settings = SubjectSettings()
