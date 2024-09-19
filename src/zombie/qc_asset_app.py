import param
import panel as pn
import pandas as pd

class MyApp(param.Parameterized):
    modality_filter = param.String(default=None)
    subject_filter = param.String(default=None)
    date_filter = param.String(default=None)

    # Sample dataframe for demonstration
    df = pd.DataFrame({
        'Subject': ['A', 'B', 'C'],
        'Date': ['2021-01-01', '2021-02-01', '2021-03-01'],
        'Modality': ['MRI', 'CT', 'X-ray']
    })

    # Create a reactive method to filter the dataframe
    @param.depends('modality_filter', 'subject_filter', 'date_filter', watch=True)
    def active(self):
        df_filtered = self.df.copy()
        
        # Filter based on modality
        if self.modality_filter:
            df_filtered = df_filtered[df_filtered['Modality'] == self.modality_filter]
        
        # Filter based on subject
        if self.subject_filter:
            df_filtered = df_filtered[df_filtered['Subject'] == self.subject_filter]
        
        # Filter based on date
        if self.date_filter:
            df_filtered = df_filtered[df_filtered['Date'] == self.date_filter]
        
        return df_filtered

# Instantiate the app
app = MyApp()

# Define selectors
select_subject = pn.widgets.Select(name="Subject ID", options=['A', 'B', 'C'], width=100, value=None)
select_modality = pn.widgets.Select(name="Modality", options=['MRI', 'CT', 'X-ray'], width=100, value=None)
select_date = pn.widgets.Select(name="Date", options=['2021-01-01', '2021-02-01', '2021-03-01'], width=100, value=None)

# Sync the widgets with the app's parameters
select_modality.link(app, value='modality_filter')
select_subject.link(app, value='subject_filter')
select_date.link(app, value='date_filter')

# Create the data table pane
data_table = pn.pane.DataFrame(app.active(), escape=False, sizing_mode="stretch_both", max_height=1200, index=False)

# Update the data table whenever filters change
@pn.depends(app.param.modality_filter, app.param.subject_filter, app.param.date_filter, watch=True)
def update_data_table(*events):
    data_table.object = app.active()

# Create the layout
layout = pn.Column(
    pn.Row(select_subject, select_modality, select_date),  # Filters
    data_table  # Data table
)

layout.servable()
