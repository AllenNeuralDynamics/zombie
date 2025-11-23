"""Entrypoint for ZOMBIE app"""

from zombie.app_contents.main_view import MainView
from zombie.data.data_loader import DataLoader
from zombie.layout import format_css_background
from zombie import __version__
import panel as pn

pn.extension("vega", "modal", disconnect_notification="Connection lost, please reload the page!", notifications=True)

format_css_background()

data_loader = DataLoader()

main_view = MainView(data_loader)

print(f"ZOMBIE/app initialized and ready. Version: {__version__}")

main_view.__panel__().servable(title="ZOMBIE")
