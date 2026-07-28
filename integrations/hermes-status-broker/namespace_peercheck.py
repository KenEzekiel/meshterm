#!/usr/bin/env python3
"""One-shot Linux namespace check for Unix peer credentials."""

import argparse
import json
import os
import socket
import struct
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True, type=Path)
    args = parser.parse_args()
    if not hasattr(socket, "SO_PEERCRED"):
        raise RuntimeError("SO_PEERCRED unavailable")
    if args.socket.exists():
        args.socket.unlink()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(str(args.socket))
        os.chmod(args.socket, 0o666)
        server.listen(1)
        connection, _ = server.accept()
        with connection:
            raw = connection.getsockopt(
                socket.SOL_SOCKET,
                socket.SO_PEERCRED,
                struct.calcsize("3i"),
            )
            pid, uid, gid = struct.unpack("3i", raw)
            print(
                json.dumps(
                    {"peer_pid": pid, "peer_uid": uid, "peer_gid": gid},
                    separators=(",", ":"),
                ),
                flush=True,
            )
            connection.sendall(b"ok\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
