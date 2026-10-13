"""Exercise the proxy's HTTP responses and concurrent request handling."""

import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer
from unittest.mock import MagicMock, patch

import pymysql

from web.docdb_proxy import (
    DocDbProxyHandler,
    _camstim_rows,
    _camstim_validation_error,
    _metadata_service_url,
)


class CamstimFormattingTests(unittest.TestCase):
    def test_completed_rows_require_mouse_and_session_identifiers(self):
        timestamp = datetime(2026, 1, 2, 3, 4, 5)
        message = "MID, 708027, UID, session-1, Action, Completed"
        rows = _camstim_rows([
            {"message": "MID, 708027, UID, session-1, Action, Started"},
            {"message": "MID, None, UID, session-1, Action, Completed"},
            {"message": "MID, 708027, Action, Completed"},
            {"message": message, "datetime": timestamp, "client_address": "rig-1 / host", "version": "1"},
            {"message": message},
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], {
            "datetime": "2026-01-02T03:04:05",
            "client_address": "rig-1 / host",
            "instrument_id": "rig-1",
            "version": "1",
            "fields": {"MID": "708027", "UID": "session-1", "Action": "Completed"},
            "raw_message": message,
        })
        self.assertIsNone(rows[1]["datetime"])
        self.assertEqual(rows[1]["instrument_id"], "")
        self.assertEqual(rows[1]["version"], "")

    def test_query_validation_preserves_errors_and_valid_parameters(self):
        self.assertEqual(
            _camstim_validation_error("", "", "bad", "", ""),
            "Missing credentials",
        )
        self.assertEqual(
            _camstim_validation_error("user", "password", "bad", "", ""),
            "Invalid table: bad",
        )
        self.assertEqual(
            _camstim_validation_error("user", "password", "last_year", "bad", "2026-01-02"),
            "Invalid date range (expected YYYY-MM-DD)",
        )
        self.assertIsNone(
            _camstim_validation_error("user", "password", "last_year", "2026-01-01", "2026-01-02")
        )


class ProxyServerTestCase(unittest.TestCase):
    handler_class = DocDbProxyHandler

    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.handler_class)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(
            self.base_url + path,
            data=body,
            headers={"Content-Type": "application/json"} if body else {},
        )
        try:
            response = urllib.request.urlopen(request, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())


class ProxyEndpointTests(ProxyServerTestCase):
    def test_log_server_returns_formatted_rows_and_closes_connection(self):
        conn = MagicMock()
        conn.__enter__.return_value = conn
        cursor = conn.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [{"message": "MID, 708027, UID, session-1, Action, Completed"}]
        with patch("pymysql.connect", return_value=conn):
            status, body = self.request("/log-server/camstim-completed", {
                "user": "test-user", "password": "test-password",
                "startDate": "2026-01-01", "endDate": "2026-01-02",
            })
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["table"], "last_year")
        self.assertEqual(body["rows"][0]["fields"]["UID"], "session-1")
        sql, parameters = cursor.execute.call_args.args
        self.assertIn("FROM last_year", sql)
        self.assertEqual(parameters, ("%Action, Completed%", "2026-01-01", "2026-01-02"))
        conn.__exit__.assert_called_once()

    def test_log_server_maps_connection_and_query_failures(self):
        payload = {
            "user": "test-user", "password": "test-password",
            "startDate": "2026-01-01", "endDate": "2026-01-02",
        }
        errors = [pymysql.err.OperationalError(2003, "unavailable"), RuntimeError("unavailable")]
        for error in errors:
            with self.subTest(error=type(error).__name__), patch("pymysql.connect", side_effect=error):
                status, body = self.request("/log-server/camstim-completed", payload)
                self.assertEqual(status, 502)
                self.assertEqual(body["error"], f"Log server connect failed: {error}")
        conn = MagicMock()
        conn.__enter__.return_value = conn
        conn.cursor.return_value.__enter__.return_value.execute.side_effect = RuntimeError("query unavailable")
        with patch("pymysql.connect", return_value=conn):
            status, body = self.request("/log-server/camstim-completed", payload)
        self.assertEqual(status, 502)
        self.assertEqual(body["error"], "Log server query failed: query unavailable")
        conn.__exit__.assert_called_once()

    def test_metadata_service_url_accepts_only_supported_lookup_paths(self):
        self.assertEqual(
            _metadata_service_url("subject/708027"),
            "https://aind-metadata-service/subject/708027",
        )
        self.assertEqual(
            _metadata_service_url("api/v2/funding/AIBS%20WB%20AAV%20Toolbox"),
            "https://aind-metadata-service/api/v2/funding/AIBS%20WB%20AAV%20Toolbox",
        )
        self.assertIsNone(_metadata_service_url("api/v2/admin/708027"))
        self.assertEqual(
            _metadata_service_url("api/v2/funding/AIBS%20WB%2FAAV"),
            "https://aind-metadata-service/api/v2/funding/AIBS%20WB%2FAAV",
        )
        self.assertIsNone(_metadata_service_url("api/v2/procedures/..%2Fadmin"))
        self.assertIsNone(_metadata_service_url("api/v2/procedures/708027?redirect=elsewhere"))

    def test_s3_list_rejects_unapproved_bucket(self):
        status, body = self.request("/s3-list?bucket=private-bucket")

        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "Bucket not allowed: private-bucket"})

    def test_log_server_validates_credentials(self):
        status, body = self.request(
            "/log-server/camstim-completed",
            {"startDate": "2026-01-01", "endDate": "2026-01-02"},
        )

        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "Missing credentials"})

    def test_log_server_maps_authentication_errors(self):
        payload = {
            "user": "test-user",
            "password": "bad-password",
            "startDate": "2026-01-01",
            "endDate": "2026-01-02",
        }
        error = pymysql.err.OperationalError(1045, "Access denied")

        with patch("pymysql.connect", side_effect=error):
            status, body = self.request("/log-server/camstim-completed", payload)

        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "Authentication failed"})

    def test_s3_list_maps_upstream_timeout(self):
        with patch.object(
            DocDbProxyHandler,
            "_s3_list_images",
            side_effect=TimeoutError("timed out"),
        ):
            status, body = self.request(
                "/s3-list?bucket=aind-analysis-prod-o5171v&prefix=plots"
            )

        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "S3 list failed: timed out"})


class SlowHandler(DocDbProxyHandler):
    slow_request_started = threading.Event()
    release_slow_request = threading.Event()

    def do_GET(self):
        if self.path == "/slow":
            self.slow_request_started.set()
            self.release_slow_request.wait(timeout=2)
            self._respond(200, {"request": "slow"})
            return
        if self.path == "/fast":
            self._respond(200, {"request": "fast"})
            return
        super().do_GET()


class ProxyConcurrencyTests(ProxyServerTestCase):
    handler_class = SlowHandler

    def setUp(self):
        SlowHandler.slow_request_started.clear()
        SlowHandler.release_slow_request.clear()
        super().setUp()

    def tearDown(self):
        SlowHandler.release_slow_request.set()
        super().tearDown()

    def test_fast_request_is_not_blocked_by_slow_request(self):
        slow_result = {}

        def request_slow():
            slow_result["response"] = self.request("/slow")

        slow_thread = threading.Thread(target=request_slow)
        slow_thread.start()
        self.assertTrue(SlowHandler.slow_request_started.wait(timeout=1))

        started = time.monotonic()
        fast_status, fast_body = self.request("/fast")
        elapsed = time.monotonic() - started

        self.assertEqual((fast_status, fast_body), (200, {"request": "fast"}))
        self.assertLess(elapsed, 0.5)
        SlowHandler.release_slow_request.set()
        slow_thread.join(timeout=2)
        self.assertEqual(slow_result["response"], (200, {"request": "slow"}))


if __name__ == "__main__":
    unittest.main()
