"""Entrypoint for ZOMBIE app"""

import logging

logging.basicConfig(level=logging.ERROR)

from zombie.app_contents.main_view import MainView
from zombie.layout import format_css_background
from zombie import __version__
import panel as pn


pn.extension("vega", "modal", disconnect_notification="Connection lost, please reload the page!", notifications=True)

format_css_background()

main_view = MainView()

print(f"ZOMBIE/app initialized and ready. Version: {__version__}")

main_view.__panel__().servable(title="ZOMBIE")
