from aind_data_access_api.document_db import MetadataDbClient
import numpy as np
import panel as pn

API_GATEWAY_HOST = "api.allenneuraldynamics.org"
DATABASE = "metadata_index"
COLLECTION = "data_assets"
TIMEOUT_1M = 60
TIMEOUT_1H = 60 * 60
TIMEOUT_24H = 60 * 60 * 24

client = MetadataDbClient(
    host=API_GATEWAY_HOST,
    database=DATABASE,
    collection=COLLECTION,
)


def get_meta():
    response = client.aggregate_docdb_records(pipeline=[
        {
            "$project": {
                "_id": 1,
                "name": 1,
                "qc_exists": {
                    "$cond": {
                        "if": { "$gt": [{ "$type": "$quality_control" }, "missing"] },
                        "then": "$quality_control.overall_status",
                        "else": None
                    }
                }
            }
        },
        {
            "$group": {
                "_id": None,
                "data": {
                    "$push": {
                        "_id": "$_id",
                        "name": "$name",
                        "qc_exists": "$qc_exists"
                    }
                }
            }
        },
        {
            "$project": {
                "_id": 0,
                "data": 1
            }
        }
    ])
    return response[0]["data"]


@pn.cache(ttl=TIMEOUT_24H)  # twenty-four hour cache
def get_all():
    filter = {}
    limit = 50
    paginate_batch_size = 500
    response = client.retrieve_docdb_records(
        filter_query=filter,
        limit=limit,
        paginate_batch_size=paginate_batch_size,
    )

    return response


@pn.cache
def get_subjects(slf):
    filter = {
        "subject.subject_id": {"$exists": True},
        "session": {"$ne": None},
    }
    limit = 1000
    paginate_batch_size = 100
    response = client.retrieve_docdb_records(
        filter_query=filter,
        projection={"_id": 0, "subject.subject_id": 1},
        limit=limit,
        paginate_batch_size=paginate_batch_size,
    )

    # turn this into a list instead of a nested list
    subjects = []
    for data in response:
        subjects.append(np.int32(data["subject"]["subject_id"]))

    return np.unique(subjects).tolist()


@pn.cache
def get_sessions(subject_id):
    """Get the raw JSON sessions list for a subject

    Parameters
    ----------
    subject_id : string or int
        _description_

    Returns
    -------
    _type_
        _description_
    """
    filter = {
        "subject.subject_id": str(subject_id),
        "session": {"$ne": "null"},
    }
    response = client.retrieve_docdb_records(
        filter_query=filter, projection={"_id": 0, "session": 1}
    )

    sessions = []
    for data in response:
        sessions.append(data["session"])

    return sessions
