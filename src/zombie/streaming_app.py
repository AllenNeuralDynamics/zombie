""" Zoomable Observatory for Multiscale Brain Investigation and Exploration """

import panel as pn
import s3fs
import altair as alt
import pandas as pd
import zarr
import param
from datetime import datetime
from zombie.database import docdb_client


pn.extension('vega')

TIMEOUT_1M = 60
TIMEOUT_1H = 60 * 60
TIMEOUT_24H = 60 * 60 * 24


class Settings(param.Parameterized):
    subject_id = param.String(default="791691")


settings = Settings()
pn.state.location.sync(settings,
                       {
                           "subject_id": "subject_id",
                       })


# Get all records
records = docdb_client.retrieve_docdb_records(
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


pn.cache()
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

# Convert both time columns to datetime (keep for reference but not used in timeline)
trials_df['start_time'] = pd.to_datetime(trials_df['start_time'], unit='s')
trials_df['stop_time'] = pd.to_datetime(trials_df['stop_time'], unit='s')

# Add the acquisition start time to the start and stop times
trials_df['start_time'] = trials_df['start_time'] + pd.Timedelta(seconds=acquisition_start_time.timestamp())
trials_df['stop_time'] = trials_df['stop_time'] + pd.Timedelta(seconds=acquisition_start_time.timestamp())

# Create a simple dataframe for the trial timeline chart using trial indices
chart_df = trials_df.reset_index(names='trial_index').copy()

print(chart_df.head())

# Create a simple chart dataframe with just trial indices
timeline_df = pd.DataFrame({
    'trial_index': chart_df['trial_index'],
    'trial_number': chart_df['trial_index']  # For visualization
})

domain = [0, len(trials_df) - 1]

selection = alt.selection_interval(
    encodings=['x'],
    name="brush",
)

chart = alt.Chart(timeline_df).mark_circle(size=30, opacity=0.7).encode(
    x=alt.X('trial_index:Q',
            scale=alt.Scale(domain=domain),
            title='Trial Number'),
    y=alt.value(50),  # Fixed y position
    tooltip=['trial_index:Q']
).properties(
    width=800,
    height=100,
).add_selection(
    selection
)

chart_pane = pn.pane.Vega(chart, sizing_mode='stretch_width')

zoom_in_button = pn.widgets.Button(width=40, height=40, icon="zoom-in", icon_size="20px")
zoom_out_button = pn.widgets.Button(width=40, height=40, icon="zoom-out", icon_size="20px")
time_forw_button = pn.widgets.Button(width=40, height=40, icon="player-track-next", icon_size="20px")
time_back_button = pn.widgets.Button(width=40, height=40, icon="player-track-prev", icon_size="20px")

timeline_controls = pn.Column(
    pn.Row(zoom_in_button, zoom_out_button),
    pn.Row(time_back_button, time_forw_button)
)

timeline_row = pn.Row(chart_pane, timeline_controls)

# Get numeric columns for scatterplot dropdowns (excluding time columns)
numeric_columns = ['trial_index']  # Add trial_index as first option
for col in trials_df.columns:
    if trials_df[col].dtype in ['int64', 'float64', 'int32', 'float32'] and col not in ['trial_index']:
        numeric_columns.append(col)

# If no numeric columns found, add some default options
if len(numeric_columns) == 1:  # Only trial_index
    numeric_columns.extend(list(trials_df.columns))

# Create dropdowns for scatterplot axes
x_axis_dropdown = pn.widgets.Select(
    name="X-Axis",
    value='trial_index',
    options=numeric_columns,
    width=200
)

y_axis_dropdown = pn.widgets.Select(
    name="Y-Axis",
    value=numeric_columns[1] if len(numeric_columns) > 1 else 'trial_index',
    options=numeric_columns,
    width=200
)

scatterplot_controls = pn.Row(
    pn.Spacer(width=50),
    x_axis_dropdown,
    y_axis_dropdown,
    sizing_mode='stretch_width'
)

# Create dropdown for histogram column
histogram_dropdown = pn.widgets.Select(
    name="Histogram Column",
    value=numeric_columns[0] if numeric_columns else 'index',
    options=numeric_columns,
    width=200
)

histogram_controls = pn.Row(
    pn.Spacer(width=50),
    histogram_dropdown,
    sizing_mode='stretch_width'
)


# Create dropdown for histogram column
histogram_dropdown = pn.widgets.Select(
    name="Histogram Column",
    value=numeric_columns[0] if numeric_columns else 'index',
    options=numeric_columns,
    width=200
)

histogram_controls = pn.Row(
    pn.Spacer(width=50),
    histogram_dropdown,
    sizing_mode='stretch_width'
)


def window(selection):
    if not selection:
        return "No selection made"
    
    # Get the trial index range from selection
    trial_start = int(selection['trial_index'][0])
    trial_end = int(selection['trial_index'][1])
    
    # Filter the timeline data to show only selected trials
    filtered_timeline = timeline_df[
        (timeline_df['trial_index'] >= trial_start) & 
        (timeline_df['trial_index'] <= trial_end)
    ]
    
    window_chart = alt.Chart(filtered_timeline).mark_circle(size=50, opacity=0.9).encode(
        x=alt.X('trial_index:Q',
                scale=alt.Scale(domain=[trial_start, trial_end]),
                title='Selected Trial Range'),
        y=alt.value(25),  # Fixed y position
        tooltip=['trial_index:Q']
    ).properties(
        width=800,
        height=50,
    )

    return pn.pane.Vega(window_chart, sizing_mode='stretch_width')


def create_scatterplot(selection, x_col, y_col):
    """Create a scatterplot filtered by the trial selection"""
    if not selection:
        # If no selection, use all data
        filtered_df = chart_df.copy()
    else:
        # Filter data based on trial index selection
        trial_start = int(selection['trial_index'][0])
        trial_end = int(selection['trial_index'][1])
        
        # Filter trials within the selected range
        mask = (
            (chart_df['trial_index'] >= trial_start) & 
            (chart_df['trial_index'] <= trial_end)
        )
        filtered_df = chart_df[mask].copy()
    
    if filtered_df.empty:
        return pn.pane.HTML("<p>No data in selected trial range</p>")
    
    # Create the scatterplot
    scatter_chart = alt.Chart(filtered_df).mark_circle(size=60, opacity=0.7).encode(
        x=alt.X(f'{x_col}:Q', title=x_col),
        y=alt.Y(f'{y_col}:Q', title=y_col),
        tooltip=[x_col, y_col, 'trial_index:Q', 'start_time:T', 'stop_time:T']
    ).properties(
        width=800,
        height=400,
        title=f"Scatterplot: {x_col} vs {y_col} ({len(filtered_df)} trials)"
    ).interactive()
    
    return pn.pane.Vega(scatter_chart, sizing_mode='stretch_width')


def create_histogram(selection, col):
    """Create a histogram filtered by the trial selection"""
    if not selection:
        # If no selection, use all data
        filtered_df = chart_df.copy()
    else:
        # Filter data based on trial index selection
        trial_start = int(selection['trial_index'][0])
        trial_end = int(selection['trial_index'][1])
        
        # Filter trials within the selected range
        mask = (
            (chart_df['trial_index'] >= trial_start) & 
            (chart_df['trial_index'] <= trial_end)
        )
        filtered_df = chart_df[mask].copy()
    
    if filtered_df.empty:
        return pn.pane.HTML("<p>No data in selected trial range</p>")
    
    # Create the histogram
    histogram_chart = alt.Chart(filtered_df).mark_bar().encode(
        x=alt.X(f'{col}:Q', bin=alt.Bin(maxbins=30), title=col),
        y=alt.Y('count()', title='Count'),
        tooltip=['count()']
    ).properties(
        width=800,
        height=400,
        title=f"Histogram: {col} ({len(filtered_df)} trials)"
    ).interactive()
    
    return pn.pane.Vega(histogram_chart, sizing_mode='stretch_width')


col = pn.Column(
    timeline_row,
    pn.bind(window, selection=chart_pane.selection.param.brush),
    pn.Spacer(height=20),
    pn.pane.HTML("<h3>Scatterplot Visualization</h3>"),
    scatterplot_controls,
    pn.bind(create_scatterplot, 
            selection=chart_pane.selection.param.brush,
            x_col=x_axis_dropdown.param.value,
            y_col=y_axis_dropdown.param.value),
    pn.Spacer(height=20),
    pn.pane.HTML("<h3>Histogram Visualization</h3>"),
    histogram_controls,
    pn.bind(create_histogram,
            selection=chart_pane.selection.param.brush,
            col=histogram_dropdown.param.value),
)

col.servable()
