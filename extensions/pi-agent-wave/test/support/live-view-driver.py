#!/usr/bin/env python3
"""Registers a real headless worker and reports the live view the extension renders for it.

Everything here is the shipped path: `headless_supervisor.py` publishes the stream, the launcher is a real
process emitting real lines, and the extension's own view renderer reads it. Only the worker's payload is a
fixture, because a live provider turn is not something a test may spend.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

PACKAGE = Path(__file__).resolve().parents[2]
SCRIPTS = PACKAGE / "scripts"
sys.path.insert(0, str(SCRIPTS))
from delegate_core import launch_headless_worker

root = Path(tempfile.mkdtemp(prefix="live-view-driver-"))
run_dir = root / "run"
run_dir.mkdir(mode=0o700)
agent_name = "dg-liveview-thinker"
attempt_dir = run_dir / "acpx" / agent_name
attempt_dir.mkdir(parents=True, mode=0o700)
cancel = attempt_dir / "cancel-acpx.sh"
cancel.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
cancel.chmod(0o700)

launcher = root / "fixture-worker.sh"
gate = root / "gate"
# A line, then a pause the driver controls, so the view is read while the worker is genuinely running.
launcher.write_text(
    "#!/bin/sh\n"
    "printf 'LIVE VIEW LINE ONE\\n'\n"
    "printf '\\033[31mCOLOURED LIVE LINE\\033[0m\\n'\n"
    f"while [ ! -f '{gate}' ]; do sleep 0.05; done\n"
    "printf 'LIVE VIEW LINE TWO\\n'\n"
    "exit 0\n",
    encoding="utf-8",
)
launcher.chmod(0o700)

resource = {
    "worker_launcher": str(launcher),
    "sandbox_base": str(root),
    "headless_stdout": str(run_dir / f"headless-{agent_name}.stdout"),
    "headless_stderr": str(run_dir / f"headless-{agent_name}.stderr"),
    "headless_status": str(run_dir / f"headless-{agent_name}.status.json"),
    "stream_token": str(run_dir / f"headless-{agent_name}.stream-token"),
    "stream_endpoint": str(run_dir / f"headless-{agent_name}.stream-endpoint.json"),
    "agent": agent_name,
    "attempt_dir": str(attempt_dir),
    "acpx_cancel_script": str(cancel),
}
pid = launch_headless_worker(resource, {**os.environ})

# Wait for the worker's first line, so the read is of a stream that is live rather than merely open.
stdout_path = Path(resource["headless_stdout"])
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if stdout_path.exists() and "LIVE VIEW LINE ONE" in stdout_path.read_text(encoding="utf-8", errors="replace"):
        break
    time.sleep(0.02)

print(json.dumps({
    "schemaVersion": 1,
    "runDir": str(run_dir),
    "attemptDir": str(attempt_dir),
    "cancelScript": str(cancel),
    "agent": agent_name,
    "workerPid": pid,
    "gate": str(gate),
    "attemptKey": f"liveview-{uuid.uuid4().hex[:12]}",
}, sort_keys=True))
sys.stdout.flush()
# Stay alive while the extension reads the view; the driver is killed by the test afterwards.
time.sleep(120)
