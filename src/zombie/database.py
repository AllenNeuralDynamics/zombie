import os

from aind_data_access_api.document_db import MetadataDbClient

API_GATEWAY_HOST = os.getenv("API_GATEWAY_HOST", "api.allenneuraldynamics-test.org")
DATABASE = os.getenv("DATABASE", "metadata_index")
COLLECTION = os.getenv("COLLECTION", "data_assets")

docdb_client = MetadataDbClient(
    host=API_GATEWAY_HOST,
    database=DATABASE,
    collection=COLLECTION,
)
