#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from delegate_core import launch_headless_worker

root = Path(tempfile.mkdtemp(prefix="headless-pi-stdio-driver-"))
launcher = root / "fake-agentfs-acpx-worker.sh"
result = root / "result.json"
launcher.write_text("#!/bin/sh\npython3 -c 'import os,sys; sys.exit(0 if os.isatty(0) else 1)' || exit 9\nprintf 'fixture stdout\\n'\nprintf 'fixture stderr\\n' >&2\nprintf '{\"schemaVersion\":1,\"result\":\"persisted\"}\\n' > \"$FIXTURE_RESULT\"\nexit 7\n", encoding="utf-8")
launcher.chmod(0o700)
resource = {
    "worker_launcher": str(launcher),
    "sandbox_base": str(root),
    "headless_stdout": str(root / "stdout"),
    "headless_stderr": str(root / "stderr"),
    "headless_status": str(root / "status.json"),
}
started = time.monotonic()
pid = launch_headless_worker(resource, {**os.environ, "FIXTURE_RESULT": str(result)})
launch_ms = round((time.monotonic() - started) * 1000)
process_group_owned = os.getsid(pid) == pid
_, status = os.waitpid(pid, 0)
summary = {
    "schemaVersion": 1,
    "pid": pid,
    "launchMs": launch_ms,
    "processGroupOwned": process_group_owned,
    "exitCode": os.waitstatus_to_exitcode(status),
    "resultPersisted": result.exists() and json.loads(result.read_text(encoding="utf-8"))["result"] == "persisted",
    "stdout": Path(resource["headless_stdout"]).read_text(encoding="utf-8").strip(),
    "stderr": Path(resource["headless_stderr"]).read_text(encoding="utf-8").strip(),
    "stdinBoundary": "private-pty",
    "argv": [str(launcher)],
    "root": str(root),
}
print(json.dumps(summary, sort_keys=True))
