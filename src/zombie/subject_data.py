""" Classes and functions for handling a single subject's data. """
import param

from zombie.database import docdb_client


class Record(param.Parameterized):
    raw_data = param.Dict()
    data = param.Parameter()
    is_raw = param.Boolean(default=False)

    def __init__(self, raw_data: dict, is_raw=False):
        super().__init__()
        self.raw_data = raw_data
        self.is_raw = is_raw


class DataAsset(param.Parameterized):
    records = param.List()

    def __init__(self, records: list):
        super().__init__()
        self.records = records


class SubjectData(param.Parameterized):
    subject_id = param.String()

    def __init__(self, subject_id):
        super().__init__()
        self.subject_id = subject_id
    
    def get_records(self):
        """Get the metadata records for the subject.
        
        """
        records = docdb_client.retrieve_docdb_records(
            filter_query={
                "subject_id": self.subject_id,
            },
        )

        # Parse the records

    
    def stream_trials(self):
        """Stream the trials table for the subject."""