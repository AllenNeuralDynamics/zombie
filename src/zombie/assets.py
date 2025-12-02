from zombie_squirrel import asset_basics
from zombie import __version__
import time

from zombie.assets_contents.panel import AssetPanel
from zombie.layout import format_css_background

format_css_background()

ONE_HOUR = 60 * 60


def get_data():
    start = time.time()
    df = asset_basics()
    end = time.time()
    print(f"Asset basics data loaded in {end - start:.2f} seconds.")
    
    return df


df = get_data()
asset_panel = AssetPanel(asset_df=df)


print(f"ZOMBIE/assets initialized and ready. Version: {__version__}")

asset_panel.servable(title="Asset Basics")
