"""Entrypoint for ZOMBIE app"""

from zombie.app_contents.main_view import MainView
from zombie.layout import format_css_background
import panel as pn

pn.extension("modal", disconnect_notification="Connection lost, please reload the page!", notifications=True)

format_css_background()

main_view = MainView()

main_view.__panel__().servable(title="ZOMBIE")
