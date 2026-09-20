#!/usr/bin/env python3
"""A subscriber that stops reading must never slow the worker down.

The first implementation published with a blocking `sendall` while holding the publisher's lock, on
the same thread that drains the worker's stdout. A subscriber that authenticated and then stopped
reading filled the socket buffer, held the drain thread, backpressured the PTY, and stalled the run
indefinitely: the capture file froze mid-run and the worker never finished. A read-only view must not
be able to do that, so this drives a real stalled subscriber against a real worker.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from delegate_core import launch_headless_worker

LINES = 20_000
MARKER = "WORKER_FINISHED_MARKER"
BUDGET_SECONDS = 60

root = Path(tempfile.mkdtemp(prefix="stream-backpressure-"))
launcher = root / "chatty-worker.sh"
# Far more output than a socket buffer holds, so a subscriber that never reads must fill it.
launcher.write_text(
    "#!/bin/sh\n"
    "i=0\n"
    f"while [ $i -lt {LINES} ]; do\n"
    '  echo "line $i ' + ("a" * 80) + '"\n'
    "  i=$((i+1))\n"
    "done\n"
    f"echo {MARKER}\n",
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
endpoint_path = Path(resource["stream_endpoint"])
deadline = time.monotonic() + 10
while time.monotonic() < deadline and not endpoint_path.exists():
    time.sleep(0.02)
endpoint = json.loads(endpoint_path.read_text(encoding="utf-8"))
token = Path(resource["stream_token"]).read_text(encoding="utf-8").strip()

# Authenticate, then never read a single byte for the rest of the worker's life.
stalled = socket.create_connection((endpoint["host"], endpoint["port"]), timeout=5)
stalled.sendall(f"{token}\n".encode("utf-8"))

stdout_path = Path(resource["headless_stdout"])
started = time.monotonic()
finished = False
while time.monotonic() - started < BUDGET_SECONDS:
    if stdout_path.exists() and MARKER in stdout_path.read_text(encoding="utf-8", errors="replace"):
        finished = True
        break
    time.sleep(0.25)
elapsed = time.monotonic() - started
try:
    os.kill(pid, 9)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass
stalled.close()

print(json.dumps({
    "schemaVersion": 1,
    "workerFinished": finished,
    "elapsedSeconds": round(elapsed, 2),
    "budgetSeconds": BUDGET_SECONDS,
    "captureBytes": stdout_path.stat().st_size if stdout_path.exists() else 0,
    "root": str(root),
}, sort_keys=True))
