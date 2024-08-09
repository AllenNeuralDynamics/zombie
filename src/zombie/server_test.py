from zombie.docdb import get_subjects, get_sessions
import pandas as pd
import altair as alt
import panel as pn

pn.extension('vega')
pn.extension(design='material')

# Initialize Panel widgets
subject_selector = pn.widgets.MultiSelect(name='Subjects', options=get_subjects())


# Function to update the data and chart based on selected subjects
pn.depends(subject_selector.param.value)
def update_chart(selected_subjects):
    print(selected_subjects)
    session_data = []

    for subj in selected_subjects:
        sessions = get_sessions(subject_id=subj)
        for session in sessions:
            if session is not None and 'session_start_time' in session.keys():
                session_data.append({'subject': subj,
                                     'start_date': session['session_start_time'],
                                     'end_date': session['session_end_time']})

    print(len(session_data))

    df_sessions = pd.DataFrame(session_data, 
                               columns=['subject', 'start_date', 'end_date'])

    if df_sessions.empty:
        return "No data available for the selected subjects"

    interval = alt.selection_interval(encodings=['x'])

    bottom_chart = (
        alt.Chart(df_sessions)
        .mark_bar()
        .encode(
            x='start_date:T',
            x2='end_date:T',
            y='subject:N',
            color='subject:N'
        )
        .add_selection(interval)
    )

    top_chart = (
        alt.Chart(df_sessions)
        .mark_bar()
        .encode(
            x=alt.X('start_date:T', scale=alt.Scale(domain=interval)),
            x2='end_date:T',
            y='subject:N',
            color='subject:N'
        )
        .properties(height=300)
    )

    combined_chart = alt.vconcat(top_chart, bottom_chart)

    return combined_chart


# Layout
layout = pn.Column(
    "# Select subjects to view sessions:",
    subject_selector,
    pn.bind(update_chart, subject_selector),
    "# Drag to select time windows (bottom chart)"
)

# Serve the dashboard
layout.servable()
