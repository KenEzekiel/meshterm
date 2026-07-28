import io
import json
import socket
import tempfile
import unittest
import urllib.request
import uuid
from collections import defaultdict, deque
from pathlib import Path
from unittest.mock import patch

import status_broker


class FakeResponse:
    def __init__(self, value, url="https://mesh.example.test"):
        self.value = json.dumps(value).encode()
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, limit):
        return self.value[:limit]

    def geturl(self):
        return self.url


class RequestTests(unittest.TestCase):
    def valid(self):
        return (
            json.dumps(
                {
                    "version": 1,
                    "request_id": str(uuid.uuid4()),
                    "operation": "status",
                }
            ).encode()
            + b"\n"
        )

    def test_accepts_only_closed_v1_status_request(self):
        request = status_broker.validate_request(self.valid())
        self.assertEqual(request["operation"], "status")

    def test_rejects_unknown_operation_and_fields(self):
        for value in (
            {"version": 1, "request_id": str(uuid.uuid4()), "operation": "send"},
            {
                "version": 1,
                "request_id": str(uuid.uuid4()),
                "operation": "status",
                "url": "https://attacker.invalid",
            },
        ):
            with self.assertRaises(status_broker.BrokerFailure):
                status_broker.validate_request(json.dumps(value).encode() + b"\n")

    def test_rejects_duplicate_fields_before_effects(self):
        request_id = str(uuid.uuid4())
        data = (
            f'{{"version":1,"request_id":"{request_id}",'
            '"operation":"status","operation":"send"}\n'
        ).encode()
        with self.assertRaises(status_broker.BrokerFailure):
            status_broker.validate_request(data)

    def test_rejects_oversized_or_unframed_input(self):
        with self.assertRaises(status_broker.BrokerFailure):
            status_broker.validate_request(b"x" * 513)
        with self.assertRaises(status_broker.BrokerFailure):
            status_broker.validate_request(self.valid()[:-1])


class FakeConnection:
    def __init__(self, request):
        self.request = request
        self.response = b""

    def settimeout(self, _timeout):
        pass

    def recv(self, _limit):
        request, self.request = self.request, b""
        return request

    def sendall(self, response):
        self.response += response


class HandleTests(unittest.TestCase):
    def broker(self):
        broker = object.__new__(status_broker.StatusBroker)
        broker.socket_path = Path("/tmp/unused.sock")
        broker.profile_path = Path("/tmp/protected-profile.json")
        broker.allowed_uids = {1000}
        broker.allowed_gids = {1000}
        broker.timeout = 1
        broker.rate_limit = 30
        broker.rate_windows = defaultdict(deque)
        broker.peer_identity = lambda _connection: (123, 1000, 1000)
        return broker

    @patch("status_broker.fetch_status")
    def test_success_audit_and_response_are_filtered(self, fetch):
        request_id = str(uuid.uuid4())
        connection = FakeConnection(
            json.dumps(
                {
                    "version": 1,
                    "request_id": request_id,
                    "operation": "status",
                }
            ).encode()
            + b"\n"
        )
        fetch.return_value = {
            "ready": True,
            "schema_version": 2,
            "journal_mode": "wal",
            "queue_depth": 0,
            "active_leases": 0,
            "acknowledged": 1,
            "dead_letters": 0,
            "discarded": 0,
            "retries": 0,
            "oldest_message_age_ms": 0,
            "average_delivery_latency_ms": 1.5,
        }
        output = io.StringIO()
        with patch("sys.stdout", output):
            self.broker().handle(connection)
        audit = output.getvalue()
        response = connection.response.decode()
        self.assertIn('"outcome":"success"', audit)
        self.assertIn('"ok":true', response)
        for forbidden in ("credential", "authorization", "payload", "lease_token"):
            self.assertNotIn(forbidden, audit.lower())
            self.assertNotIn(forbidden, response.lower())

    @patch("status_broker.fetch_status")
    def test_unsupported_operation_fails_before_profile_or_network(self, fetch):
        connection = FakeConnection(
            json.dumps(
                {
                    "version": 1,
                    "request_id": str(uuid.uuid4()),
                    "operation": "send",
                }
            ).encode()
            + b"\n"
        )
        with patch("sys.stdout", io.StringIO()):
            self.broker().handle(connection)
        self.assertFalse(fetch.called)
        self.assertIn(b'"ok":false', connection.response)


class UpstreamTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.profile = Path(self.directory.name) / "kage.json"
        self.profile.write_text(
            json.dumps(
                {
                    "server": "https://mesh.example.test",
                    "credential": "mtk_not-printed",
                }
            )
        )

    def tearDown(self):
        self.directory.cleanup()

    def response(self, request, **_kwargs):
        self.assertIsInstance(request, urllib.request.Request)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(
            request.get_header("User-agent"),
            status_broker.BROKER_USER_AGENT,
        )
        if request.full_url.endswith("/readyz"):
            self.assertEqual(
                request.full_url,
                "https://mesh.example.test/readyz",
            )
            self.assertIsNone(request.get_header("Authorization"))
            return FakeResponse(
                {
                    "ok": True,
                    "store": {
                        "ok": True,
                        "journal_mode": "wal",
                        "schema_version": 2,
                    },
                },
                request.full_url,
            )
        self.assertEqual(request.full_url, "https://mesh.example.test/v1/metrics")
        self.assertEqual(request.get_header("Authorization"), "Bearer mtk_not-printed")
        return FakeResponse(
            {
                "queue_depth": 0,
                "active_leases": 0,
                "acknowledged": 1,
                "dead_letters": 0,
                "discarded": 0,
                "retries": 0,
                "oldest_message_age_ms": 0,
                "average_delivery_latency_ms": 1.5,
            },
            request.full_url,
        )

    @patch("urllib.request.OpenerDirector.open")
    def test_calls_only_fixed_endpoints_and_filters_response(self, open_request):
        open_request.side_effect = self.response
        result = status_broker.fetch_status(self.profile, 1)
        self.assertEqual(
            set(result),
            {"ready", "schema_version", "journal_mode", *status_broker.STATUS_KEYS},
        )
        self.assertEqual(open_request.call_count, 2)

    @patch("urllib.request.OpenerDirector.open")
    def test_rejects_unknown_upstream_fields(self, open_request):
        def response(request, **kwargs):
            value = self.response(request, **kwargs)
            if request.full_url.endswith("/v1/metrics"):
                parsed = json.loads(value.value)
                parsed["payload"] = "must-not-pass"
                return FakeResponse(parsed, request.full_url)
            return value

        open_request.side_effect = response
        with self.assertRaises(status_broker.BrokerFailure):
            status_broker.fetch_status(self.profile, 1)

    def test_rejects_non_origin_profile_servers(self):
        for server in (
            "http://mesh.example.test",
            "https://user@mesh.example.test",
            "https://mesh.example.test/path",
            "https://mesh.example.test?query=1",
            "https://mesh.example.test/#fragment",
        ):
            self.profile.write_text(
                json.dumps({"server": server, "credential": "mtk_test"})
            )
            with self.assertRaises(status_broker.BrokerFailure):
                status_broker.load_profile(self.profile)

    @patch("urllib.request.OpenerDirector.open")
    def test_rejects_redirected_or_changed_origins(self, open_request):
        open_request.return_value = FakeResponse(
            {
                "ok": True,
                "store": {
                    "ok": True,
                    "journal_mode": "wal",
                    "schema_version": 2,
                },
            },
            "https://attacker.invalid/readyz",
        )
        with self.assertRaises(status_broker.BrokerFailure) as failure:
            status_broker.fetch_status(self.profile, 1)
        self.assertEqual(failure.exception.code, "upstream_unavailable")
        self.assertEqual(open_request.call_count, 1)

    def test_redirect_handler_never_constructs_a_followup_request(self):
        handler = status_broker.RejectRedirects()
        self.assertIsNone(
            handler.redirect_request(
                urllib.request.Request("https://mesh.example.test/v1/metrics"),
                None,
                302,
                "Found",
                {},
                "https://attacker.invalid/v1/metrics",
            )
        )

    @patch("urllib.request.OpenerDirector.open")
    def test_exhausted_deadline_stops_before_metrics(self, open_request):
        open_request.side_effect = self.response
        with patch(
            "status_broker.time.monotonic",
            side_effect=[10.0, 10.0, 12.0],
        ):
            with self.assertRaises(status_broker.BrokerFailure):
                status_broker.fetch_status(self.profile, 1)
        self.assertEqual(open_request.call_count, 1)


@unittest.skipUnless(hasattr(socket, "SO_PEERCRED"), "Linux SO_PEERCRED required")
class PeerCredentialTests(unittest.TestCase):
    def test_kernel_reports_real_peer_and_ignores_request_identity(self):
        left, right = socket.socketpair(socket.AF_UNIX)
        try:
            broker = status_broker.StatusBroker(
                Path("/tmp/unused.sock"),
                Path("/tmp/unused.json"),
                {0},
                {0},
            )
            _pid, uid, gid = broker.peer_identity(left)
            self.assertGreaterEqual(uid, 0)
            self.assertGreaterEqual(gid, 0)
        finally:
            left.close()
            right.close()

    def test_unauthorized_peer_causes_no_profile_or_network_access(self):
        left, right = socket.socketpair(socket.AF_UNIX)
        output = io.StringIO()
        broker = status_broker.StatusBroker(
            Path("/tmp/unused.sock"),
            Path("/tmp/must-not-read.json"),
            {999_999},
            {999_999},
        )
        with (
            patch("sys.stdout", output),
            patch("status_broker.fetch_status") as fetch,
        ):
            broker.handle(left)
        self.assertFalse(fetch.called)
        audit = output.getvalue()
        self.assertIn("unauthorized_peer", audit)
        self.assertNotIn("credential", audit)
        left.close()
        right.close()


if __name__ == "__main__":
    unittest.main()
