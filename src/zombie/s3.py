# Placeholder code to be replaced with boto3 calls
import panel as pn

import zarr
import s3fs
import boto3
from pathlib import Path

uri = 's3://aind-scratch-data/postprocessed_test_zarr/postprocessed_experiment1_Record Node 104#Neuropix-PXI-100.zarr/'


def _load_zarr(fpath):
    return zarr.open(fpath, mode='r')


class SpikeSorting():

    def __init__(self, uri='s3://aind-scratch-data/postprocessed_test_zarr/postprocessed_experiment1_Record Node 104#Neuropix-PXI-100.zarr/',
                 backend='local'):
        """_summary_

        Parameters
        ----------
        backend : str, optional
            'local' or 's3', by default 'local'
        """
        self.uri = uri
        self.backend = backend

        if self.backend == 's3':
            self.store = s3fs.S3Map(root=uri, s3=s3fs.S3FileSystem(), check=False)

    def _get_file(self, relative_filepath):
        """_summary_

        Parameters
        ----------
        relative_filepath : _type_
            _description_
        """
        if self.backend == 'local':
            fpath = Path('./files/data/') / relative_filepath
            za = _load_zarr(fpath)[:]
            return za
        elif self.backend == 's3':
            parts = Path(relative_filepath).parts
            za = _load_zarr(self.store[parts[0]][parts[1]][parts[2]])[:]
            return za

    def st(self):
        """Get spike times
        """
        return self._get_file('sorting/spikes/sample_index')

    def clu(self):
        """Get cluster identities"""
        return self._get_file('sorting/spikes/unit_index')

    def locs(self):
        """Get unit locations"""
        return self._get_file('extensions/unit_locations/unit_locations')
