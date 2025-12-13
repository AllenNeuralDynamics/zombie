import pandas as pd
import panel as pn
from panel.custom import PyComponent

from aind_metadata_utils.data_assets import name_to_metadata_view_link, name_to_qc_view_link, co_id_to_co_link

from zombie.layout import OUTER_STYLE


class AssetPanel(PyComponent):

    def __init__(self, asset_df, **params):
        super().__init__(**params)
        self.asset_df = self._process_df(asset_df)

    def _process_df(self, df):
        # Replace the content of the location with an HTML link "S3 link"
        df['location'] = df['location'].apply(lambda x: f'<a href="{x}" target="_blank">S3 link</a>')

        # QC link column
        df['qc'] = df['name'].apply(name_to_qc_view_link)
        df['metadata'] = df['name'].apply(name_to_metadata_view_link)

        # CO link column
        df['co'] = df['code_ocean'].apply(co_id_to_co_link)

        # Format process_date to remove milliseconds and timezone, append (UTC)
        df['process_date'] = pd.to_datetime(df['process_date'], format='mixed')
        df['process_date (UTC)'] = df['process_date'].apply(lambda x: x.strftime('%Y-%m-%d %H:%M:%S') if pd.notna(x) else None)

        # Re-order columns to place _last_modified at the front
        print(df.columns.tolist())
        # ['_id', '_last_modified', 'modalities', 'project_name', 'data_level', 'subject_id', 'acquisition_start_time', 'acquisition_end_time', 'code_ocean', 'process_date', 'genotype', 'location', 'name', 'qc', 'metadata', 'co']

        ordered_cols = ['subject_id', 'acquisition_start_time', 'project_name', 'modalities', 'co', 'metadata', 'qc', 'data_level', 'process_date (UTC)', 'genotype']
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
