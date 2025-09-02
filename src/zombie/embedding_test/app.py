import json
import pandas as pd
import numpy as np
import panel as pn
import altair as alt
from sklearn.feature_extraction import DictVectorizer
import umap.umap_ as umap

pn.extension('vega', 'jsoneditor')

from zombie.data.docdb import docdb_client

records = docdb_client.retrieve_docdb_records(
    filter_query={
        "data_description.project_name": "Ephys Platform",
    },
    projection={
        "subject": 1,
    }
)


def parse_record(record):
    # Extract subject metadata from the record
    subject_data = record["subject"]

    if not subject_data or "subject_id" not in subject_data:
        print("Missing subject_id in record")
        return None, None

    del subject_data["schema_version"]

    subject_id = subject_data["subject_id"]
    del subject_data["subject_id"]
    return subject_id, json.dumps(subject_data)


subject_metadata = {
    subject_id: metadata
    for record in records
    for subject_id, metadata in [parse_record(record)]
}

# Remove any None values from the dictionary
subject_metadata = {k: v for k, v in subject_metadata.items() if k is not None and v is not None}


def json_metadata_embedding_view(subject_metadata: dict[str, str]) -> pn.Column:
    # Parse and vectorize JSON metadata
    ids = []
    records = []
    
    # Helper function to flatten nested dictionaries
    def flatten_dict(d, parent_key='', sep='_'):
        items = []
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            if isinstance(v, dict):
                items.extend(flatten_dict(v, new_key, sep=sep).items())
            else:
                items.append((new_key, v))
        return dict(items)

    for subject_id, metadata_str in subject_metadata.items():
        try:
            data = json.loads(metadata_str)
            # Flatten nested dictionaries before vectorization
            flat_data = flatten_dict(data)
            records.append(flat_data)
            ids.append(subject_id)
        except json.JSONDecodeError:
            continue  # skip bad JSON

    # Replace anything with a value of None with a string
    records = [{k: (v if v is not None else "None") for k, v in record.items()} for record in records]

    vec = DictVectorizer(sparse=False)
    X = vec.fit_transform(records)

    # Project using UMAP
    embedding = umap.UMAP(n_components=2, random_state=42).fit_transform(X)
    df = pd.DataFrame(embedding, columns=["x", "y"])
    df["subject_id"] = ids

    # Add Altair selection for legend
    selection = alt.selection_multi(fields=["subject_id"], name="Select", bind="legend")
    
    # Add point selection for displaying metadata
    point_selection = alt.selection_point(
        fields=["subject_id"], 
        name="PointSelect",
        empty="none"  # Don't clear selection when clicking empty space
    )
    # zoom = alt.selection_interval(bind='scales', on='wheel!')
    
    chart = (
        alt.Chart(df)
        .mark_circle(size=80)
        .encode(
            x="x:Q",
            y="y:Q",
            color=alt.condition(selection, alt.value("steelblue"), alt.value("lightgray")),
            tooltip="subject_id:N",
            opacity=alt.condition(selection | point_selection, alt.value(1.0), alt.value(0.2)),
            stroke=alt.condition(point_selection, alt.value("black"), alt.value(None)),
            strokeWidth=alt.condition(point_selection, alt.value(2), alt.value(0)),
        )
        .add_params(selection, point_selection)
        .interactive()
        .properties(width=600, height=400, title="Subject Metadata UMAP Projection")
    )

    subject_select = pn.widgets.MultiChoice(
        name="Select Subjects", options=ids, value=[],
        width=400
    )

    def filter_chart(subjects):
        if not subjects:
            filtered_df = df
        else:
            filtered_df = df[df["subject_id"].isin(subjects)]
        updated_chart = (
            alt.Chart(filtered_df)
            .mark_circle(size=80)
            .encode(
                x="x:Q",
                y="y:Q",
                color=alt.value("orange"),
                tooltip="subject_id:N",
            )
            .interactive()
            .properties(width=600, height=400)
        )
        return updated_chart

    filtered_pane = pn.bind(filter_chart, subject_select)

    return pn.pane.Vega(filtered_pane, sizing_mode='stretch_width', width=600)

view = pn.Column(
        pn.pane.Markdown("## UMAP Projection of Subject Metadata"),
        pn.Row(subject_select),
        pn.panel(chart),
        json_metadata_embedding_view(subject_metadata),
    )
view.servable()
