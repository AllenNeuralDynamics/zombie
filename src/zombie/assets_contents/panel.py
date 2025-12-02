import panel as pn
from panel.custom import PyComponent

from zombie.layout import OUTER_STYLE


class AssetPanel(PyComponent):

    def __init__(self, asset_df, **params):
        super().__init__(**params)
        self.asset_df = self._process_df(asset_df)

    def _process_df(self, df):
        # Replace the content of the location with an HTML link "S3 link"
        df['location'] = df['location'].apply(lambda x: f'<a href="{x}" target="_blank">S3 link</a>')

        # QC link column
        df['qc'] = df['name'].apply(lambda x: f'<a href="https://qc.allenneuraldynamics-test.org/view?name={x}" target="_blank">QC link</a>')
        df['metadata'] = df['name'].apply(lambda x: f'<a href="https://metadata-portal.allenneuraldynamics-test.org/view?name={x}" target="_blank">Metadata link</a>')

        # CO link column
        df['co'] = df['code_ocean'].apply(lambda x: f'<a href="https://codeocean.allenneuraldynamics.org/data-assets/{x}" target="_blank">CO link</a>')

        # Re-order columns to place _last_modified at the front
        print(df.columns.tolist())
        ordered_cols = ['subject_id', 'acquisition_start_time', 'project_name', 'modalities', 'location', 'qc', 'co', 'metadata', 'data_level', 'process_date', 'genotype']
        df = df[ordered_cols]

        # Sort DF by the _last_modified column in descending order
        df = df.sort_values(by="acquisition_start_time", ascending=False)
        
        return df

    def __panel__(self):
        return pn.Column(
            pn.widgets.Tabulator(
                self.asset_df,
                header_filters=True,
                show_index=False,
                disabled=True,
                page_size=100,
                layout='fit_columns',
                sizing_mode="stretch_both",
                formatters={
                    "location": {"type": "html"},
                    "qc": {"type": "html"},
                    "co": {"type": "html"},
                    "metadata": {"type": "html"},
                },
                hidden_columns=['name', 'acquisition_end_time'],
            ),
            styles=OUTER_STYLE,
        )
