""" Zoomable Observatory for Multiscale Brain Investigation and Exploration """

import panel as pn
from hdmf_zarr import NWBZarrIO
import altair as alt
import pandas as pd


pn.extension('vega')

# Load Zarr NWB file
with NWBZarrIO('files/data/behavior_791691_2025-04-29_11-10-29.nwb', mode='r') as io:
    nwbfile = io.read()

    # Access trials as a DataFrame
    trials_df = nwbfile.trials.to_dataframe()

print(trials_df['start_time'][0:10])

# Convert both time columns to datetime
trials_df['start_time'] = pd.to_datetime(trials_df['start_time'], unit='s')
trials_df['stop_time'] = pd.to_datetime(trials_df['stop_time'], unit='s')

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
