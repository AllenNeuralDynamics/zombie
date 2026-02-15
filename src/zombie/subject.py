import panel as pn

from zombie.layout import format_css_background
from zombie.subject_contents.subject_app import SubjectApp

format_css_background()


pn.extension()

app = SubjectApp()
app.panel.servable(title="Subject view")
