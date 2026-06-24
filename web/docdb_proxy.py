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

import html
import json
import logging
import re
import ssl
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

import pymysql
import pymysql.cursors
from aind_data_access_api.document_db import MetadataDbClient

PORT = 3001
HOST = "127.0.0.1"

LOG_SERVER_HOST = "eng-logtools"
LOG_SERVER_PORT = 3306
LOG_SERVER_DATABASE = "mpe"
LOG_SERVER_ALLOWED_TABLES = {"last_2week", "last_2month", "last_year", "log_server"}
LOG_SERVER_CONNECT_TIMEOUT = 10
LOG_SERVER_READ_TIMEOUT = 60

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

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Keys we know are "atomic" (no embedded commas/braces).
# Anything else gets captured up to the next known key boundary.
_ACQ_KNOWN_KEYS = (
    "Action", "Report Status", "OphysSessionID", "UID", "MID",
    "Date_timestamp", "Stimulus",
    "Stim_Long_Frames", "Stim_Extra_Long_Frames", "Stim_Mean_Frame_Interval_ms",
    "MVR_Behavior_Dropped_Frames", "MVR_Eye_Dropped_Frames",
    "MVR_Face_Dropped_Frames", "MVR_Nose_Dropped_Frames",
    "Licks_Detected_MVR", "Licks_Detected_Sync", "Licks_Detected_Pickle",
    "Encoder_Distance_cm", "File", "Arguments", "Output path",
)


def _parse_acquisition_message(msg: str) -> dict:
    if not msg:
        return {}
    msg = html.unescape(msg)
    key_alt = "|".join(re.escape(k) for k in _ACQ_KNOWN_KEYS)
    pattern = re.compile(rf",\s*(?={key_alt})\s*")
    parts = pattern.split(", " + msg)
    out: dict[str, str] = {}
    for chunk in parts:
        chunk = chunk.strip().strip(",").strip()
        if not chunk:
            continue
        idx = chunk.find(",")
        if idx == -1:
            continue
        key = chunk[:idx].strip()
        val = chunk[idx + 1:].strip().rstrip(",").strip()
        if key:
            out[key] = val
    return out


def _client_address_to_instrument(addr: str) -> str:
    if not addr:
        return ""
    head = addr.split(" / ", 1)[0].strip()
    return head.replace("-Acq", "").replace("-Comp", "")


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
        elif self.path == "/log-server/acquisition-reports":
            self._handle_acquisition_reports()
        else:
            self._respond(404, {"error": "Not found"})

    def _handle_acquisition_reports(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) if length else b"{}")
        except Exception as e:
            self._respond(400, {"error": f"Invalid JSON: {e}"})
            return

        user = (body.get("user") or "").strip()
        password = body.get("password") or ""
        table = (body.get("table") or "last_year").strip()
        start_date = (body.get("startDate") or "").strip()
        end_date = (body.get("endDate") or "").strip()

        if not user or not password:
            self._respond(400, {"error": "Missing credentials"})
            return
        if table not in LOG_SERVER_ALLOWED_TABLES:
            self._respond(400, {"error": f"Invalid table: {table}"})
            return
        if not _DATE_RE.match(start_date) or not _DATE_RE.match(end_date):
            self._respond(400, {"error": "Invalid date range (expected YYYY-MM-DD)"})
            return

        try:
            conn = pymysql.connect(
                host=LOG_SERVER_HOST,
                port=LOG_SERVER_PORT,
                user=user,
                password=password,
                database=LOG_SERVER_DATABASE,
                connect_timeout=LOG_SERVER_CONNECT_TIMEOUT,
                read_timeout=LOG_SERVER_READ_TIMEOUT,
                cursorclass=pymysql.cursors.DictCursor,
            )
        except pymysql.err.OperationalError as e:
            code = e.args[0] if e.args else None
            if code in (1045, 1044, 1698):
                self._respond(401, {"error": "Authentication failed"})
                return
            log.error("Log server connect failed: %s", e)
            self._respond(502, {"error": f"Log server connect failed: {e}"})
            return
        except Exception as e:
            log.error("Log server connect failed: %s", e)
            self._respond(502, {"error": f"Log server connect failed: {e}"})
            return

        try:
            with conn:
                with conn.cursor() as cur:
                    sql = (
                        f"SELECT datetime, client_address, version, message "
                        f"FROM {table} "
                        "WHERE logname='acquisition_report' AND level='INFO' "
                        "AND message LIKE %s "
                        "AND datetime >= %s AND datetime < %s "
                        "ORDER BY datetime DESC"
                    )
                    cur.execute(sql, ("Action, Acquisition Report Generated%", start_date, end_date))
                    raw_rows = cur.fetchall()
        except Exception as e:
            log.error("Log server query failed: %s", e)
            self._respond(502, {"error": f"Log server query failed: {e}"})
            return

        out = []
        for r in raw_rows:
            parsed = _parse_acquisition_message(r.get("message") or "")
            out.append({
                "datetime": r["datetime"].isoformat() if r.get("datetime") else None,
                "client_address": r.get("client_address") or "",
                "instrument_id": _client_address_to_instrument(r.get("client_address") or ""),
                "version": r.get("version") or "",
                "fields": parsed,
                "raw_message": r.get("message") or "",
            })

        self._respond(200, {"rows": out, "count": len(out), "table": table})

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
