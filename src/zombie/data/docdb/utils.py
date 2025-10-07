"""Functionality tied to the document database."""

from typing import Optional
from aind_data_access_api.document_db import MetadataDbClient
import panel as pn

client = MetadataDbClient(
    host="api.allenneuraldynamics.org",
    version="v2",
)

TTL_DAY = 24 * 60 * 60
TTL_HOUR = 60 * 60


@pn.cache(ttl=TTL_DAY)
def get_unique_project_names():
    """Get unique project names from the database"""

    try:
        unique_projects = client.aggregate_docdb_records(
            pipeline=[
                {"$group": {"_id": "$data_description.project_name"}},
                {"$project": {"project_name": "$_id", "_id": 0}},
            ],
        )
        return [project["project_name"] for project in unique_projects]
    except Exception as e:
        print(f"Error fetching unique project names: {e}")
        return []


def get_unique_modalities(project_names: Optional[list[str]] = None):
    """Get unique modalities from the database"""

    if project_names is None:
        return []

    pipeline = []

    if project_names:
        pipeline.append({"$match": {"data_description.project_name": {"$in": project_names}}})

    pipeline.append({"$group": {"_id": "$data_description.modalities.abbreviation"}})
    pipeline.append({"$project": {"modality": "$_id", "_id": 0}})

    try:
        unique_modalities = client.aggregate_docdb_records(
            pipeline=pipeline,
        )
        modalities_nested_list = [modality["modality"] for modality in unique_modalities]
        # flatten list before returning
        modalities = [item for sublist in modalities_nested_list for item in sublist]
        return list(set(modalities))
    except Exception as e:
        print(f"Error fetching unique modalities: {e}")
        return []


@pn.cache(ttl=TTL_DAY)
def get_subject_ids(project_names: Optional[list[str]] = None):
    """Get unique subject IDs for the given project names"""

    try:
        subject_ids = client.aggregate_docdb_records(
            pipeline=(
                [
                    {"$match": {"data_description.project_name": {"$in": project_names}}},
                    {"$group": {"_id": "$subject.subject_id"}},
                    {"$project": {"subject_id": "$_id", "_id": 0}},
                ]
                if project_names
                else [{"$group": {"_id": "$subject.subject_id"}}, {"$project": {"subject_id": "$_id", "_id": 0}}]
            ),
        )
        return [subject["subject_id"] for subject in subject_ids]
    except Exception as e:
        print(f"Error fetching subject IDs: {e}")
        return []


@pn.cache(ttl=TTL_HOUR)
def get_acquisition_time_range(project_names: list[str]):
    """Get the earliest start time for the given project names"""

    try:
        time_range = client.aggregate_docdb_records(
            pipeline=[
                {"$match": {"data_description.project_name": {"$in": project_names}}},
                {
                    "$group": {
                        "_id": None,
                        "min_start_time": {"$min": "$acquisition.acquisition_start_time"},
                        "max_start_time": {"$max": "$acquisition.acquisition_start_time"},
                    }
                },
                {"$project": {"min_start_time": "$min_start_time", "max_start_time": "$max_start_time", "_id": 0}},
            ],
        )
        if time_range:
            return (
                time_range[0]["min_start_time"],
                time_range[0]["max_start_time"],
            )
        return None
    except Exception as e:
        print(f"Error fetching start time: {e}")
        return None


@pn.cache(ttl=TTL_HOUR)
def get_acquisition_start_end_times(project_names: list[str]):
    """Get all paired start and end times for the given project names"""
    
    try:
        time_ranges = client.aggregate_docdb_records(
            pipeline=[
                {"$match": {"data_description.project_name": {"$in": project_names}}},
                {
                    "$project": {
                        "start_time": "$acquisition.acquisition_start_time",
                        "end_time": "$acquisition.acquisition_end_time",
                        "_id": 0,
                    }
                },
                {"$match": {"start_time": {"$ne": None}, "end_time": {"$ne": None}}},
            ],
        )
        return [(tr["start_time"], tr["end_time"]) for tr in time_ranges if "start_time" in tr and "end_time" in tr]
    except Exception as e:
        print(f"Error fetching acquisition start and end times: {e}")
        return []