#!/usr/bin/env python3
"""
docdb_proxy.py — Local HTTP proxy for the AIND DocDB REST API and
                 the internal aind-metadata-service.

Listens on :3001 and exposes:
  POST /metadata/search          {"filter": {...}, "limit": N, "projection": {...}}
  POST /v1/metadata/search       (DocDB v1 variant)
  GET  /metadata-service/<path>  proxied to https://aind-metadata-service/<path>
                                  (self-signed cert verification is disabled)

Forwards requests to the AIND DocDB internal API via aind_data_access_api,
and forwards arbitrary GETs to the internal metadata service. Both run
server-side (where the internal network is accessible), so the browser
never has to reach the internal hosts directly.

Usage:
  python web/docdb_proxy.py    (or via `npm run docdb`)
"""

import json
import logging
import ssl
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from aind_data_access_api.document_db import MetadataDbClient

PORT = 3001
HOST = "127.0.0.1"

# Timeout for upstream metadata-service requests (seconds).
# The /procedures endpoint commonly takes ~45 seconds to respond.
METADATA_SERVICE_TIMEOUT = 120

# Base URL for the internal metadata service. Self-signed cert => verify=False.
METADATA_SERVICE_BASE = "https://aind-metadata-service"
_METADATA_SERVICE_SSL = ssl.create_default_context()
_METADATA_SERVICE_SSL.check_hostname = False
_METADATA_SERVICE_SSL.verify_mode = ssl.CERT_NONE

logging.basicConfig(level=logging.INFO, format="[docdb-proxy] %(message)s")
log = logging.getLogger(__name__)

client_v2 = MetadataDbClient(host="api.allenneuraldynamics.org", version="v2")
client_v1 = MetadataDbClient(host="api.allenneuraldynamics.org", version="v1")

# Legacy alias used by existing code paths
client = client_v2


class DocDbProxyHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/metadata-service/"):
            self._handle_metadata_service(self.path[len("/metadata-service/"):])
        else:
            self._respond(404, {"error": "Not found"})

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

    def _handle_metadata_service(self, subpath):
        # Pass the request verbatim to the upstream.
        # Importantly: 4xx responses (e.g. 406 for schema-invalid objects) still
        # carry a usable body ("data" for v1, the object directly for v2), so we
        # always forward the body regardless of status code.
        url = f"{METADATA_SERVICE_BASE}/{subpath}"
        req = urllib.request.Request(url, method="GET")
        raw = b""
        content_type = "application/json"
        try:
            with urllib.request.urlopen(
                req,
                context=_METADATA_SERVICE_SSL,
                timeout=METADATA_SERVICE_TIMEOUT,
            ) as resp:
                raw = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            # Read the body even on 4xx — the payload is still valid JSON.
            raw = e.read() or b""
            content_type = e.headers.get("Content-Type", "application/json")
            log.info("metadata-service returned HTTP %s for %s (body forwarded)", e.code, url)
        except Exception as e:
            log.error("metadata-service request failed: %s", e)
            self._respond(502, {"error": f"Upstream request failed: {e}"})
            return
        # Always respond 200 to the browser — the JS unpacks the body itself.
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

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
