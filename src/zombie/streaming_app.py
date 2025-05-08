""" Zoomable Observatory for Multiscale Brain Investigation and Exploration """

import panel as pn
import s3fs
import altair as alt
import pandas as pd
import zarr
import param
import os
from datetime import datetime

from aind_data_access_api.document_db import MetadataDbClient


pn.extension('vega')
API_GATEWAY_HOST = os.getenv("API_GATEWAY_HOST", "api.allenneuraldynamics-test.org")
DATABASE = os.getenv("DATABASE", "metadata_index")
COLLECTION = os.getenv("COLLECTION", "data_assets")

TIMEOUT_1M = 60
TIMEOUT_1H = 60 * 60
TIMEOUT_24H = 60 * 60 * 24

client = MetadataDbClient(
    host=API_GATEWAY_HOST,
    database=DATABASE,
    collection=COLLECTION,
)


class Settings(param.Parameterized):
    subject_id = param.String(default="791691")


settings = Settings()
pn.state.location.sync(settings,
                       {
                           "subject_id": "subject_id",
                       })


# Get all records
records = client.retrieve_docdb_records(
    filter_query={
        "subject_id": settings.subject_id,
        "data_description.data_level": "derived",
    },
    projection={
        "name": 1,
        "location": 1,
    }
)
# Build a dataframe from the records to track all the 


def get_data():
    # S3 Zarr path
    s3_zarr_path = "s3://codeocean-s3datasetsbucket-1u41qdg42ur9/417d11c1-d4df-4f72-a84a-66753a503aeb/nwb/behavior_791691_2025-04-29_11-10-29.nwb/"

    # Create S3 filesystem
    fs = s3fs.S3FileSystem(anon=False)

    # Map S3 path to Zarr store
    store = s3fs.S3Map(root=s3_zarr_path, s3=fs, check=False)

    # Open Zarr group
    root = zarr.open(store, mode='r')

    start_time = root['session_start_time'][...][0].decode('utf-8')
    print(start_time)

    # Navigate to trials table
    trials_group = root['/intervals/trials']

    data = {}
    # Read all columns into a dict of arrays
    for key in trials_group.array_keys():
        values = trials_group[key][...]

        # If not a 1D array, flatten values into a comma separated list
        if values.ndim > 1:
            print(f"Flattening {key} from shape {values.shape}")
            values = [','.join(map(str, row)) for row in values]

        data[key] = list(values)

    return data, start_time


data, start_time = get_data()

acquisition_start_time = datetime.fromisoformat(str(start_time))

# Convert to pandas DataFrame
print("Converting to DataFrame")
trials_df = pd.DataFrame(data)
print("DataFrame created")

# Show DataFrame
print(len(trials_df))
print(trials_df.columns)
# print(trials_df.head())
print(trials_df['start_time'][0:10])

# Convert both time columns to datetime
trials_df['start_time'] = pd.to_datetime(trials_df['start_time'], unit='s')
trials_df['stop_time'] = pd.to_datetime(trials_df['stop_time'], unit='s')

# Add the acquisition start time to the start and stop times
trials_df['start_time'] = trials_df['start_time'] + pd.Timedelta(seconds=acquisition_start_time.timestamp())
trials_df['stop_time'] = trials_df['stop_time'] + pd.Timedelta(seconds=acquisition_start_time.timestamp())

chart_df = trials_df.copy()
chart_df['start_time_str'] = trials_df['start_time'].dt.strftime('%Y-%m-%dT%H:%M:%S')
chart_df['stop_time_str'] = trials_df['stop_time'].dt.strftime('%Y-%m-%dT%H:%M:%S')

chart_df = chart_df.reset_index(names='index')

print(chart_df.head())

melted_df = pd.melt(
    chart_df,
    id_vars=['index'],  # Assuming 'id' exists; if not, use another identifier column
    value_vars=['start_time_str', 'stop_time_str'],
    var_name='time_type',
    value_name='time'
)

domain = [chart_df['start_time_str'].min(), chart_df['stop_time_str'].max()]

selection = alt.selection_interval(
    encodings=['x'],
    name="brush",
)

chart = alt.Chart(melted_df).mark_rule(size=0.1).encode(
    x=alt.X('time:T',
            scale=alt.Scale(domain=domain),
            title='Time (hh:mm)'),
    color=alt.Color('time_type:N', 
                   scale=alt.Scale(
                       domain=['start_time_str', 'stop_time_str'],
                       range=['blue', 'red']
                   ),
                   legend=alt.Legend(title="Event Type"))
).properties(
    width=800,
    height=100,
).add_selection(
    selection
)

chart_pane = pn.pane.Vega(chart, sizing_mode='stretch_width')


def window(selection):
    if not selection:
        return "No selection made"
    range_predicate = {
        'and': [{
            'field': key,
            'range': [selection[key][0], selection[key][1]]
        } for key in selection]
    }
    # Compute the new domain based on the selection
    new_domain = [
        selection['time'][0],
        selection['time'][1]
    ]
    window_chart = alt.Chart(melted_df).mark_rule(size=0.5).encode(
        x=alt.X('time:T',
                scale=alt.Scale(domain=new_domain),
                title='Time (hh:mm)'),
        color=alt.Color('time_type:N', 
                    scale=alt.Scale(
                        domain=['start_time_str', 'stop_time_str'],
                        range=['blue', 'red']
                    ),
                    legend=None,
        ),
    ).properties(
        width=800,
        height=50,
    ).transform_filter(
        range_predicate
    )

    return pn.pane.Vega(window_chart, sizing_mode='stretch_width')

col = pn.Column(
    chart_pane,
    pn.bind(window, selection=chart_pane.selection.param.brush),
)

col.servable()
