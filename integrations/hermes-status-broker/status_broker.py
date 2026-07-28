#!/usr/bin/env python3
"""Status-only Meshterm credential broker for the Hermes home-lab integration."""

from __future__ import annotations

import argparse
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

VERSION = 1
MAX_REQUEST_BYTES = 512
MAX_UPSTREAM_BYTES = 8_192
MAX_RESPONSE_BYTES = 8_192
DEFAULT_TIMEOUT_SECONDS = 3.0
BROKER_USER_AGENT = "meshterm-status-broker/1.0"
STATUS_KEYS = (
    "queue_depth",
    "active_leases",
    "acknowledged",
    "dead_letters",
    "discarded",
    "retries",
    "oldest_message_age_ms",
    "average_delivery_latency_ms",
)
ERROR_MESSAGES = {
    "unauthorized_peer": "peer is not authorized",
    "invalid_request": "request is invalid",
    "unsupported_version": "protocol version is unsupported",
    "profile_unavailable": "status profile is unavailable",
    "upstream_unavailable": "status is unavailable",
    "upstream_unauthorized": "status authorization failed",
    "invalid_upstream_response": "status response is invalid",
    "audit_unavailable": "audit is unavailable",
    "internal_error": "status is unavailable",
}


class BrokerFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BrokerFailure("invalid_request")
        result[key] = value
    return result


def parse_id_set(value: str) -> set[int]:
    try:
        result = {int(item) for item in value.split(",") if item}
    except ValueError as error:
        raise ValueError("peer id allowlists must contain integers") from error
    if not result or any(item < 0 for item in result):
        raise ValueError("peer id allowlists must not be empty or negative")
    return result


def validate_request(data: bytes) -> dict[str, Any]:
    if len(data) > MAX_REQUEST_BYTES or not data.endswith(b"\n"):
        raise BrokerFailure("invalid_request")
    try:
        text = data[:-1].decode("utf-8", errors="strict")
        request = json.loads(text, object_pairs_hook=strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, BrokerFailure):
        raise BrokerFailure("invalid_request")
    if not isinstance(request, dict):
        raise BrokerFailure("invalid_request")
    if set(request) != {"version", "request_id", "operation"}:
        raise BrokerFailure("invalid_request")
    if request["version"] != VERSION:
        raise BrokerFailure("unsupported_version")
    if request["operation"] != "status":
        raise BrokerFailure("invalid_request")
    try:
        parsed_id = uuid.UUID(request["request_id"])
    except (AttributeError, TypeError, ValueError):
        raise BrokerFailure("invalid_request")
    if str(parsed_id) != request["request_id"]:
        raise BrokerFailure("invalid_request")
    return request


def load_profile(path: Path) -> tuple[str, str]:
    try:
        profile = json.loads(path.read_text(encoding="utf-8"))
        server = profile["server"]
        credential = profile["credential"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        raise BrokerFailure("profile_unavailable")
    if not isinstance(server, str) or not isinstance(credential, str):
        raise BrokerFailure("profile_unavailable")
    try:
        parsed = urllib.parse.urlsplit(server)
        _ = parsed.port
    except ValueError:
        raise BrokerFailure("profile_unavailable")
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or not credential.startswith("mtk_")
    ):
        raise BrokerFailure("profile_unavailable")
    return f"https://{parsed.netloc}", credential


def read_json_response(
    request: urllib.request.Request,
    timeout: float,
) -> dict[str, Any]:
    try:
        opener = urllib.request.build_opener(
            RejectRedirects(),
            urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        )
        with opener.open(
            request,
            timeout=timeout,
        ) as response:
            if response.geturl() != request.full_url:
                raise BrokerFailure("upstream_unavailable")
            data = response.read(MAX_UPSTREAM_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            raise BrokerFailure("upstream_unauthorized")
        raise BrokerFailure("upstream_unavailable")
    except (OSError, TimeoutError, urllib.error.URLError):
        raise BrokerFailure("upstream_unavailable")
    if len(data) > MAX_UPSTREAM_BYTES:
        raise BrokerFailure("invalid_upstream_response")
    try:
        value = json.loads(data, object_pairs_hook=strict_object)
    except (
        UnicodeDecodeError,
        json.JSONDecodeError,
        BrokerFailure,
    ):
        raise BrokerFailure("invalid_upstream_response")
    if not isinstance(value, dict):
        raise BrokerFailure("invalid_upstream_response")
    return value


def bounded_nonnegative(value: Any, *, integer: bool) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise BrokerFailure("invalid_upstream_response")
    if integer and not isinstance(value, int):
        raise BrokerFailure("invalid_upstream_response")
    if value < 0 or value > 9_007_199_254_740_991:
        raise BrokerFailure("invalid_upstream_response")
    if isinstance(value, float) and not (float("-inf") < value < float("inf")):
        raise BrokerFailure("invalid_upstream_response")
    return value


def remaining(deadline: float) -> float:
    value = deadline - time.monotonic()
    if value <= 0:
        raise BrokerFailure("upstream_unavailable")
    return value


def fetch_status(
    profile_path: Path,
    timeout: float,
    deadline: float | None = None,
) -> dict[str, Any]:
    deadline = deadline if deadline is not None else time.monotonic() + timeout
    server, credential = load_profile(profile_path)
    ready = read_json_response(
        urllib.request.Request(
            f"{server}/readyz",
            method="GET",
            headers={"User-Agent": BROKER_USER_AGENT},
        ),
        remaining(deadline),
    )
    metrics = read_json_response(
        urllib.request.Request(
            f"{server}/v1/metrics",
            method="GET",
            headers={
                "Authorization": f"Bearer {credential}",
                "User-Agent": BROKER_USER_AGENT,
            },
        ),
        remaining(deadline),
    )
    if set(ready) != {"ok", "store"} or ready["ok"] is not True:
        raise BrokerFailure("invalid_upstream_response")
    store = ready["store"]
    if (
        not isinstance(store, dict)
        or set(store) != {"ok", "journal_mode", "schema_version"}
        or store["ok"] is not True
        or not isinstance(store["journal_mode"], str)
        or len(store["journal_mode"]) > 16
    ):
        raise BrokerFailure("invalid_upstream_response")
    schema_version = bounded_nonnegative(store["schema_version"], integer=True)
    if set(metrics) != set(STATUS_KEYS):
        raise BrokerFailure("invalid_upstream_response")
    filtered: dict[str, Any] = {
        "ready": True,
        "schema_version": schema_version,
        "journal_mode": store["journal_mode"],
    }
    for key in STATUS_KEYS:
        filtered[key] = bounded_nonnegative(
            metrics[key],
            integer=key != "average_delivery_latency_ms",
        )
    return filtered


class StatusBroker:
    def __init__(
        self,
        socket_path: Path,
        profile_path: Path,
        allowed_uids: set[int],
        allowed_gids: set[int],
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        rate_limit: int = 30,
    ) -> None:
        if not hasattr(socket, "SO_PEERCRED"):
            raise RuntimeError("kernel peer credentials are unavailable")
        if timeout <= 0 or timeout > 30:
            raise ValueError("timeout must be greater than zero and at most 30")
        if rate_limit < 1 or rate_limit > 10_000:
            raise ValueError("rate limit must be between 1 and 10000")
        self.socket_path = socket_path
        self.profile_path = profile_path
        self.allowed_uids = allowed_uids
        self.allowed_gids = allowed_gids
        self.timeout = timeout
        self.rate_limit = rate_limit
        self.rate_windows: dict[int, deque[float]] = defaultdict(deque)

    def audit(
        self,
        request_id: str,
        uid: int,
        gid: int,
        outcome: str,
        reason: str,
        started: float,
    ) -> None:
        event = {
            "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "event": "meshterm.status_broker",
            "request_id": request_id[:64],
            "peer_uid": uid,
            "peer_gid": gid,
            "operation": "status",
            "outcome": outcome,
            "reason": reason,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
        try:
            print(json.dumps(event, separators=(",", ":")), flush=True)
        except (OSError, ValueError):
            raise BrokerFailure("audit_unavailable")

    def rate_allowed(self, uid: int) -> bool:
        now = time.monotonic()
        window = self.rate_windows[uid]
        while window and window[0] <= now - 60:
            window.popleft()
        if len(window) >= self.rate_limit:
            return False
        window.append(now)
        return True

    def peer_identity(self, connection: socket.socket) -> tuple[int, int, int]:
        credentials = connection.getsockopt(
            socket.SOL_SOCKET,
            socket.SO_PEERCRED,
            struct.calcsize("3i"),
        )
        return struct.unpack("3i", credentials)

    def response(self, request_id: str, status: dict[str, Any]) -> bytes:
        return (
            json.dumps(
                {
                    "version": VERSION,
                    "request_id": request_id,
                    "ok": True,
                    "status": status,
                },
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
            + b"\n"
        )

    def error_response(self, request_id: str, code: str) -> bytes:
        return (
            json.dumps(
                {
                    "version": VERSION,
                    "request_id": request_id,
                    "ok": False,
                    "error": {"code": code, "message": ERROR_MESSAGES[code]},
                },
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )

    def handle(self, connection: socket.socket) -> None:
        started = time.monotonic()
        deadline = started + self.timeout
        request_id = "unknown"
        uid = gid = -1
        try:
            connection.settimeout(remaining(deadline))
            _pid, uid, gid = self.peer_identity(connection)
            if uid not in self.allowed_uids or gid not in self.allowed_gids:
                raise BrokerFailure("unauthorized_peer")
            if not self.rate_allowed(uid):
                raise BrokerFailure("invalid_request")
            data = b""
            while not data.endswith(b"\n") and len(data) <= MAX_REQUEST_BYTES:
                connection.settimeout(remaining(deadline))
                chunk = connection.recv(min(256, MAX_REQUEST_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data += chunk
            request = validate_request(data)
            request_id = request["request_id"]
            status = fetch_status(self.profile_path, self.timeout, deadline)
            self.audit(request_id, uid, gid, "success", "ok", started)
            response = self.response(request_id, status)
        except BrokerFailure as error:
            try:
                self.audit(request_id, uid, gid, "rejected", error.code, started)
                response = self.error_response(request_id, error.code)
            except BrokerFailure:
                return
        except Exception:
            try:
                self.audit(request_id, uid, gid, "failed", "internal_error", started)
                response = self.error_response(request_id, "internal_error")
            except BrokerFailure:
                return
        if len(response) <= MAX_RESPONSE_BYTES:
            try:
                connection.sendall(response)
            except OSError:
                pass

    def serve_forever(self) -> None:
        self.socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
        directory = self.socket_path.parent.stat()
        if directory.st_mode & 0o002:
            raise RuntimeError("broker directory must not be world-writable")
        if self.socket_path.exists():
            if not self.socket_path.is_socket():
                raise RuntimeError("broker path exists and is not a socket")
            self.socket_path.unlink()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(self.socket_path))
            os.chmod(self.socket_path, 0o660)
            server.listen(8)
            while True:
                connection, _ = server.accept()
                with connection:
                    self.handle(connection)


def main() -> int:
    parser = argparse.ArgumentParser(description="Status-only Meshterm broker")
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument(
        "--allowed-uids",
        default=os.environ.get("MESHTERM_STATUS_ALLOWED_UIDS", ""),
    )
    parser.add_argument(
        "--allowed-gids",
        default=os.environ.get("MESHTERM_STATUS_ALLOWED_GIDS", ""),
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--rate-limit", type=int, default=30)
    args = parser.parse_args()
    try:
        broker = StatusBroker(
            args.socket,
            args.profile,
            parse_id_set(args.allowed_uids),
            parse_id_set(args.allowed_gids),
            args.timeout,
            args.rate_limit,
        )
        broker.serve_forever()
    except (OSError, RuntimeError, ValueError) as error:
        print(f"status broker failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
