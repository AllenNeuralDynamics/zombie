import panel as pn
from zombie_squirrel import asset_basics
from zombie import __version__
import time

from zombie.layout import OUTER_STYLE, format_css_background

format_css_background()

start = time.time()
df = asset_basics()
end = time.time()
print(f"Asset basics data loaded in {end - start:.2f} seconds.")

# Sort DF by the _last_modified column in descending order
df = df.sort_values(by="acquisition_start_time", ascending=False)

# Replace the content of the location with an HTML link "S3 link"
df['location'] = df['location'].apply(lambda x: f'<a href="{x}" target="_blank">S3 link</a>')

# Reconstruct the name column
df['name'] = df.apply(lambda row: f"{row['subject_id']}_{row['acquisition_start_time']}", axis=1)

# QC link column
df['qc'] = df['name'].apply(lambda x: f'<a href="https://qc.allenneuraldynamics-test.org/view?name={x}" target="_blank">QC link</a>')

# CO link column
df['co'] = df['code_ocean'].apply(lambda x: f'<a href="https://codeocean.allenneuraldynamics.org/data-assets/{x}" target="_blank">CO link</a>')

# Re-order columns to place _last_modified at the front
print(df.columns.tolist())
ordered_cols = ['subject_id', 'acquisition_start_time', 'project_name', 'modalities', 'location', 'qc', 'co', 'data_level', 'process_date', 'genotype', '_id', '_last_modified', 'acquisition_end_time', 'name']
df = df[ordered_cols]

col = pn.Column(
    pn.widgets.Tabulator(
        df,
        header_filters=True,
        show_index=False,
        disabled=True,
        page_size=100,
        layout='fit_data_table',
        sizing_mode="stretch_both",
        formatters={
            "location": {"type": "html"},
            "qc": {"type": "html"},
            "co": {"type": "html"},
        },
        hidden_columns=['name', 'acquisition_end_time'],
    ),
    styles=OUTER_STYLE,
)

print(f"ZOMBIE/assets initialized and ready. Version: {__version__}")

col.servable(title="Asset Basics")
