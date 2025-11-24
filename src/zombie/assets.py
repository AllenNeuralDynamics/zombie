import panel as pn
from zombie_squirrel import asset_basics
from zombie import __version__
import time

start = time.time()
df = asset_basics()
end = time.time()
print(f"Asset basics data loaded in {end - start:.2f} seconds.")


col = pn.Column(
    pn.widgets.Tabulator(df, header_filters=True, show_index=False, disabled=True)
)

print(f"ZOMBIE/assets initialized and ready. Version: {__version__}")

col.servable(title="Asset Basics")
