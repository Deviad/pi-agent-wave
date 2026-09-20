#!/usr/bin/env python3
"""Proves a worker's output reaches both sinks as it is written, with or without a line ending.

The supervisor, the loopback listener and the subscriber are the shipped ones; only the worker's payload is
a fixture. The launcher prints text with no newline and then waits for a gate file, so "the capture holds
it" and "the channel published it" are observed while the worker provably cannot have exited, rather than
inferred from the end state.

The drain is then driven directly over a real pipe as well, because what it publishes in is not observable
from a socket: that case pins the bound on an unterminated remainder, and the byte shape of the capture when
the PTY's `\\r\\n` straddles two reads.
"""

from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
import threading
import time

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import headless_supervisor
import stream_endpoint
from delegate_core import launch_headless_worker

MARKER = "partial output with no newline"
TAIL = "tail line"
RUN_BYTES = 20_000
root = Path(tempfile.mkdtemp(prefix="partial-line-driver-"))
# The test that runs this takes ownership of the root this driver reports, but a driver that crashes before
# printing its report cannot hand it over, and that is how scratch roots accumulate. This removes it either
# way, which makes the test's own removal a no-op rather than the only thing standing between a failure and
# a leaked directory.
atexit.register(shutil.rmtree, root, ignore_errors=True)
launcher = root / "fixture-worker.sh"
gate = root / "gate"
launcher.write_text(
    "#!/bin/sh\n"
    f"printf '{MARKER}'\n"
    f"while [ ! -f '{gate}' ]; do sleep 0.02; done\n"
    f"printf '{TAIL}\\n'\n"
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
capture_path = Path(resource["headless_stdout"])
token_path = Path(resource["stream_token"])
endpoint_path = Path(resource["stream_endpoint"])


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


deadline = time.monotonic() + 10
while time.monotonic() < deadline and not (token_path.exists() and endpoint_path.exists()):
    time.sleep(0.02)
endpoint = json.loads(endpoint_path.read_text(encoding="utf-8"))
address = (endpoint["host"], int(endpoint["port"]))

subscriber = socket.create_connection(address, timeout=5)
subscriber.sendall(f"{token_path.read_text(encoding='utf-8').strip()}\n".encode("utf-8"))

# The worker is gated: it cannot exit until this file exists, so anything observed here was observed while
# it was still running. A drain that waits for a line ending leaves the capture empty at this point.
started = time.monotonic()
seen_in_capture = False
while time.monotonic() - started < 10:
    if capture_path.exists() and MARKER in capture_path.read_text(encoding="utf-8", errors="replace"):
        seen_in_capture = True
        break
    time.sleep(0.02)
seconds_to_capture = round(time.monotonic() - started, 3)
gate_closed_when_seen = not gate.exists()
seen_in_channel = read_until(subscriber, MARKER, timeout=5) if seen_in_capture else ""
gate.write_text("go", encoding="utf-8")
tail = read_until(subscriber, TAIL)
subscriber.close()
_, status = os.waitpid(pid, 0)
exit_code = os.waitstatus_to_exitcode(status)

# The drain over a real pipe: a single unterminated run far longer than any read, then a `\r` whose `\n`
# arrives in a later read, so the newline shape of the capture is pinned whether or not the pair straddles.
parts: list[str] = []


class Recorder:
    def publish(self, chunk: str) -> None:
        parts.append(chunk)


read_fd, write_fd = os.pipe()
carry_gate = root / "carry-gate"
drain_capture_path = root / "drain-capture"
run_text = "y" * RUN_BYTES
with os.fdopen(read_fd, "r", encoding="utf-8") as stream, drain_capture_path.open("w", encoding="utf-8") as target:

    def writer() -> None:
        with os.fdopen(write_fd, "wb") as out:
            out.write(run_text.encode("utf-8"))
            out.flush()
            out.write(b"\r")
            out.flush()
            deadline = time.monotonic() + 10
            while not carry_gate.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            out.write(b"\n")
            out.flush()
            out.write(b"after\n")
            out.flush()

    def release_carry() -> None:
        """Waits until the capture holds the run, which is only true while the trailing `\\r` is held back."""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if drain_capture_path.exists() and drain_capture_path.read_text(encoding="utf-8", errors="replace") == run_text:
                carry_gate.write_text("go", encoding="utf-8")
                return
            time.sleep(0.02)

    writer_thread = threading.Thread(target=writer, daemon=True)
    watcher = threading.Thread(target=release_carry, daemon=True)
    writer_thread.start()
    watcher.start()
    headless_supervisor.drain(stream, target, Recorder())
    writer_thread.join(timeout=10)
    watcher.join(timeout=10)

capture_text = drain_capture_path.read_text(encoding="utf-8")
expected = run_text + "\n" + "after\n"

# The channel's window is bounded in size as well as in number, so a fast worker cannot grow the
# supervisor's memory through it. A small window makes the trim observable on a real socket.
WINDOW_CAP_BYTES = 5_000
WINDOW_CHUNK_BYTES = 1_000
WINDOW_CHUNKS = 50
window_token = root / "window-token"
publisher = stream_endpoint.StreamPublisher(window_token, backlog_bytes=WINDOW_CAP_BYTES)
for index in range(WINDOW_CHUNKS):
    publisher.publish(f"{index:04d}-" + "w" * (WINDOW_CHUNK_BYTES - 6) + "\n")
window_subscriber = socket.create_connection((publisher.host, publisher.port), timeout=5)
window_subscriber.sendall(f"{publisher.token}\n".encode("utf-8"))
window = ""
window_subscriber.settimeout(0.5)
window_deadline = time.monotonic() + 3
while time.monotonic() < window_deadline:
    try:
        piece = window_subscriber.recv(65536)
    except socket.timeout:
        break
    if not piece:
        break
    window += piece.decode("utf-8", "replace")
window_subscriber.close()
publisher.close()

report = {
    "schemaVersion": 1,
    "captureMarkerSeenWhileGated": seen_in_capture,
    "gateStillClosedWhenSeen": gate_closed_when_seen,
    "secondsToCapture": seconds_to_capture,
    "captureWhileRunning": capture_path.read_text(encoding="utf-8", errors="replace")[:120] if capture_path.exists() else "",
    "channelWhileRunning": seen_in_channel,
    "tailInChannel": tail,
    "exitCode": exit_code,
    "drain": {
        "chunkLimit": getattr(headless_supervisor, "READ_CHUNK_BYTES", 0),
        "parts": len(parts),
        "maxPartBytes": max((len(part) for part in parts), default=0),
        "totalBytes": len("".join(parts)),
        "captureBytes": len(capture_text),
        "carryWithheld": carry_gate.exists(),
        "captureMatchesNormalized": capture_text == expected,
        "partsConcatenationMatchesCapture": "".join(parts) == expected,
    },
    "window": {
        "cap": WINDOW_CAP_BYTES,
        "chunkBytes": WINDOW_CHUNK_BYTES,
        "publishedChunks": WINDOW_CHUNKS,
        "windowBytes": len(window),
        "hasNewest": f"{WINDOW_CHUNKS - 1:04d}-" in window,
        "hasOldest": f"{0:04d}-" in window,
    },
    "root": str(root),
}
print(json.dumps(report, sort_keys=True))