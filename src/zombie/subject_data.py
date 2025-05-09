""" Classes and functions for handling a single's data. """
import param


class SubjectData(param.Parameterized):
    subject_id = param.String()

    def __init__(self, subject_id):
        super().__init__()
        self.subject_id = subject_id
    
    