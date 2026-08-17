import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import pymysql

from web.docdb_proxy import DocDbProxyHandler


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
