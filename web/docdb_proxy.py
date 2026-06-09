#!/usr/bin/env python3
"""
docdb_proxy.py — Local HTTP proxy for the AIND DocDB REST API.

Listens on :3001 and exposes a single endpoint:
  POST /metadata/search  {"filter": {...}, "limit": N, "projection": {...}}

Forwards requests to the AIND DocDB internal API via aind_data_access_api.
This runs server-side (where the internal network is accessible), so the
browser never needs to reach the API directly.

Usage:
  python web/docdb_proxy.py    (or via `npm run docdb`)
"""

import json
import logging
from http.server import BaseHTTPRequestHandler, HTTPServer

from aind_data_access_api.document_db import MetadataDbClient

PORT = 3001
HOST = "127.0.0.1"

logging.basicConfig(level=logging.INFO, format="[docdb-proxy] %(message)s")
log = logging.getLogger(__name__)

client_v2 = MetadataDbClient(host="api.allenneuraldynamics.org", version="v2")
client_v1 = MetadataDbClient(host="api.allenneuraldynamics.org", version="v1")

# Legacy alias used by existing code paths
client = client_v2


class DocDbProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/v1/metadata/search":
            self._handle_search(client_v1)
        elif self.path == "/metadata/search":
            self._handle_search(client_v2)
        else:
            self._respond(404, {"error": "Not found"})

    def _handle_search(self, db_client):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) if length else b"{}")
        except Exception as e:
            self._respond(400, {"error": f"Invalid JSON: {e}"})
            return

        filter_query = body.get("filter", {})
        limit = body.get("limit", 1000)
        projection = body.get("projection") or None

        try:
            kwargs = dict(filter_query=filter_query, limit=limit)
            if projection:
                kwargs["projection"] = projection
            records = db_client.retrieve_docdb_records(**kwargs)
            self._respond(200, records)
        except Exception as e:
            log.error("DocDB query failed: %s", e)
            self._respond(500, {"error": str(e)})

    def _respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.info(fmt, *args)


if __name__ == "__main__":
    HTTPServer.allow_reuse_address = True
    server = HTTPServer((HOST, PORT), DocDbProxyHandler)
    log.info("Listening on %s:%d", HOST, PORT)
    server.serve_forever()
