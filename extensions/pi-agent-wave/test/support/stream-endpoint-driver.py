#!/usr/bin/env python3
"""Drives the headless live stream against a real supervisor, a real loopback listener and a real worker.

Nothing here is simulated: the supervisor process is the shipped one, the launcher is a small script that
writes real lines, and the subscriber is a real socket. Only the worker's payload is a fixture.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import stream_endpoint
from delegate_core import launch_headless_worker


def read_until(connection: socket.socket, needle: str, timeout: float = 10.0) -> str:
    connection.settimeout(timeout)
    received = ""
    deadline = time.monotonic() + timeout
    while needle not in received and time.monotonic() < deadline:
        try:
            chunk = connection.recv(4096)
        except socket.timeout:
            break
        if not chunk:
            break
        received += chunk.decode("utf-8", "replace")
    return received


def wait_for(path: Path, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            return True
        time.sleep(0.02)
    return False


root = Path(tempfile.mkdtemp(prefix="stream-endpoint-driver-"))
launcher = root / "fixture-worker.sh"
gate = root / "gate"
# Emits one line, then waits for the gate file so the endpoint is observably live mid-run, then emits more.
launcher.write_text(
    "#!/bin/sh\n"
    "printf 'first line\\n'\n"
    f"while [ ! -f '{gate}' ]; do sleep 0.05; done\n"
    "printf 'second line\\n'\n"
    "exit 0\n",
    encoding="utf-8",
)
launcher.chmod(0o700)

resource = {
    "worker_launcher": str(launcher),
    "sandbox_base": str(root),
    "headless_stdout": str(root / "stdout"),
    "headless_stderr": str(root / "stderr"),
    "headless_status": str(root / "status.json"),
    "stream_token": str(root / "stream-token"),
    "stream_endpoint": str(root / "stream-endpoint.json"),
}

pid = launch_headless_worker(resource, {**os.environ})
token_path = Path(resource["stream_token"])
endpoint_path = Path(resource["stream_endpoint"])
report: dict[str, object] = {
    "schemaVersion": 1,
    "backends": {name: stream_endpoint.resolve_stream_backend(name) for name in stream_endpoint.SUPPORTED_PLATFORMS},
    "tokenAppeared": wait_for(token_path),
    "endpointAppeared": wait_for(endpoint_path),
}
report["tokenMode"] = oct(token_path.stat().st_mode & 0o777) if token_path.exists() else None
# Poll the descriptor as tightly as the platform allows and record every read that did not parse. A
# descriptor published by truncate-then-write is readable while it is still empty, which is exactly what a
# subscriber keying on existence would hit.
invalid_reads = 0
attempts = 0
while not endpoint_path.exists() and attempts < 20_000:
    attempts += 1
endpoint: dict = {}
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    try:
        parsed = json.loads(endpoint_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        invalid_reads += 1
        continue
    if parsed:
        endpoint = parsed
        break
report["descriptorInvalidReads"] = invalid_reads
report["endpoint"] = endpoint
token = token_path.read_text(encoding="utf-8").strip() if token_path.exists() else ""

address = (endpoint.get("host", "127.0.0.1"), int(endpoint.get("port", 0)))
# A connection that presents no valid token is refused and receives no worker output.
refused = socket.create_connection(address, timeout=5)
refused.sendall(b"not-the-token\n")
report["withoutToken"] = read_until(refused, "\n", timeout=3).strip()
refused.close()

# Subscribe only once the first line has demonstrably been emitted, so the backlog window is what carries it.
deadline = time.monotonic() + 10.0
while time.monotonic() < deadline and "first line" not in Path(resource["headless_stdout"]).read_text(encoding="utf-8"):
    time.sleep(0.02)

# A connection that presents the token receives the lines already emitted, then the live ones.
subscriber = socket.create_connection(address, timeout=5)
subscriber.sendall(f"{token}\n".encode("utf-8"))
report["backlog"] = read_until(subscriber, "first line")
gate.write_text("go", encoding="utf-8")
report["live"] = read_until(subscriber, "second line")
subscriber.close()

_, status = os.waitpid(pid, 0)
report["exitCode"] = os.waitstatus_to_exitcode(status)
report["tokenRemovedAfterExit"] = not token_path.exists()
report["endpointRemovedAfterExit"] = not endpoint_path.exists()
try:
    gone = socket.create_connection(address, timeout=2)
    gone.close()
    report["endpointGoneAfterExit"] = False
except OSError:
    report["endpointGoneAfterExit"] = True
# The channel retains nothing of its own: only the token and endpoint descriptor exist while it runs,
# and both are gone afterwards. Every other file in the run directory belongs to the capture path.
report["filesAfterExit"] = sorted(path.name for path in root.iterdir())
report["root"] = str(root)

try:
    stream_endpoint.resolve_stream_backend("Plan9")
    report["unsupportedPlatform"] = None
except ValueError as error:
    report["unsupportedPlatform"] = str(error)

print(json.dumps(report, sort_keys=True))
