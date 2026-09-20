#!/usr/bin/env python3
"""Exercises the candidate-less failure bundle against a real supervisor, a real worker and the shipped settler.

The 2026-09-12 operations smoke lost an attempt that exited cleanly with no candidate and had nothing to
diagnose it from. This drives that exact shape through the production path - `launch_headless_worker` starts
the real supervisor, the launcher is a real process, and `settle_runtime_attempt` is the shipped function -
and reports what it retained. Only the worker's payload is a fixture, because "a worker that produced no
candidate" is a shape no live provider turn can be asked for reliably.
"""

from __future__ import annotations

import atexit
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import delegate_core as core

core.ACTIVE_TRANSPORT = "headless"

root = Path(tempfile.mkdtemp(prefix="failure-bundle-driver-"))
home = root / "home"
(home / ".codex").mkdir(parents=True)
(home / ".codex" / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "offline-fixture-not-a-credential"}))
os.environ["HOME"] = str(home)
os.environ["CODEX_HOME"] = str(home / ".codex")
os.environ.pop("PI_CLAUDE_OAUTH_TOKEN_FILE", None)
os.environ["DELEGATE_GRAPH_DB"] = str(root / "graph.db")

base = root / "base"
base.mkdir()
private = root / "private"
private.mkdir(mode=0o700)
os.chdir(base)

model = "openai-codex/gpt-5.6-sol"
task = private / "task.md"
task.write_text("Fixture task; no model is dispatched.")
task.chmod(0o600)

args = core.build_parser().parse_args(["start", str(private), "searcher", "--node", "search", "--model", model, "--access-mode", "read-only"])
resource, _ = core.prepare_acpx_attempt(private, args, {"run_label": "failure-bundle-fixture"}, "fixture-worker", model, task, "search")
attempt_dir = Path(resource["attempt_dir"])
# The fields command_start adds before launching; prepare_acpx_attempt deliberately does not carry them.
resource.update({
    "headless_stdout": str(private / "headless-fixture-worker.stdout"),
    "headless_stderr": str(private / "headless-fixture-worker.stderr"),
    "headless_status": str(private / "headless-fixture-worker.status.json"),
    "stream_token": str(private / "headless-fixture-worker.stream-token"),
    "stream_endpoint": str(private / "headless-fixture-worker.stream-endpoint.json"),
    "run_dir": str(private),
    "agent": "fixture-worker",
    "role": "searcher",
    "node": "search",
    "operation_id": "op-candidate-less",
    "tab": None,
    "pane": None,
    "worker_pid": None,
})

# A worker that exits cleanly having captured nothing: the shape the failure bundle exists for. It also
# emits far more than the diagnostic window, so the same run shows the retained capture is a bounded tail.
event_total = core.FAILURE_DIAGNOSTIC_EVENT_LIMIT * 6
launcher = private / "fixture-worker.sh"
launcher.write_text(
    "#!/bin/sh\n"
    f"mkdir -p '{attempt_dir}/runtime-output'\n"
    f": > '{attempt_dir}/runtime-output/public-answer.txt'\n"
    f"i=0\nwhile [ $i -lt {event_total} ]; do\n"
    "  printf '{\"method\":\"session/update\",\"seq\":%s}\\n' \"$i\"\n"
    "  i=$((i+1))\n"
    "done | tee -a " + "'" + str(attempt_dir) + "/runtime-output/worker.stdout.ndjson' >/dev/null\n"
    "printf 'acpx: the reply arrived outside the prompt turn\\n' | tee " + "'" + str(attempt_dir) + "/worker.stderr.txt' >&2\n"
    f"cat > '{resource['worker_result']}' <<'JSON'\n"
    '{"schemaVersion": 2, "resultContract": "runtime-v1", "agent": "codex", "selectedModel": "' + model + '",'
    ' "sessionName": "' + resource["acpx_session"] + '", "attemptKey": "' + resource["acpx_attempt_key"] + '",'
    ' "outputDir": "' + str(attempt_dir / "runtime-output") + '", "output": {"schemaVersion": 1,'
    ' "attemptKey": "' + resource["acpx_attempt_key"] + '", "sessionId": "' + resource["acpx_session"] + '",'
    ' "outcome": {"kind": "exited", "exitCode": 0}, "capture": {"requestId": "3", "sessionId": "acp-created",'
    ' "sessionOrigin": "created", "captureStatus": "empty", "responseCompleteness": "unverified", "inputBytes": 1,'
    ' "answerBytes": 0, "publicChunks": 0, "ignoredEvents": ' + str(event_total) + ', "peakBufferedBytes": 0,'
    ' "diagnostics": []}, "stderrTruncated": false}}\n'
    "JSON\n"
    "exit 0\n",
    encoding="utf-8",
)
launcher.chmod(0o700)
resource["worker_launcher"] = str(launcher)

# The real supervisor, the real process group, the real exit code.
worker_pid = core.launch_headless_worker(resource, {**os.environ})


def _stop_worker() -> None:
    """Stops the supervisor and everything it leads, however this driver exits.

    The supervisor starts in its own session, so a plain kill would leave its PTY child and worker behind.
    """
    try:
        os.killpg(os.getpgid(worker_pid), signal.SIGKILL)
    except OSError:
        pass
    try:
        os.waitpid(worker_pid, os.WNOHANG)
    except OSError:
        pass


resource["worker_pid"] = worker_pid
result_path = Path(str(resource["worker_result"]))
deadline = time.monotonic() + 30
while time.monotonic() < deadline and not result_path.exists():
    time.sleep(0.05)
supervisor_exited = result_path.exists()

# The settle steps that need a real ACPX session (presentation identity, session close, provider links,
# cleanup absence) cannot succeed for a fixture worker that never made one, so the clean variant stands in
# for exactly those and nothing else - the same substitution the runtime lifecycle test makes. The
# `--with-post-settlement-failure` variant patches none of them, which is how the abort path's effect on
# the candidate-less bundle becomes observable.
if "--with-post-settlement-failure" not in sys.argv:
    core.observe_presentation_identity = lambda r: {"presentationVerified": True, "identityMatches": True, "transport": "headless", "herdrVisible": False}
    core.close_acpx_attempt = lambda r: {"closed": True, "noSession": True}
    core.verify_provider_links = lambda *a, **k: True
    core.abort_acpx_attempt = lambda r, **k: []
    core.verify_cleanup_absence = lambda run_dir, r, **k: (run_dir / "cleanup-fixture-worker.json")

audit: dict[str, object] = {}
error: str | None = None
try:
    audit = core.settle_runtime_attempt(private, resource)
except Exception as caught:  # a settlement failure is itself a result worth reporting
    error = f"{type(caught).__name__}: {caught}"

report: dict[str, object] = {
    "schemaVersion": 1,
    "supervisorExited": supervisor_exited,
    "settlementError": error,
    "valid": audit.get("valid"),
    "postSettlementFailures": [str(item)[:200] for item in (audit.get("postSettlementFailures") or [])],
    "diagnosticsPath": audit.get("diagnosticsPath"),
    "captureRetainedPath": audit.get("captureRetainedPath"),
    "settlementEvidencePath": audit.get("settlementEvidencePath"),
    "root": str(root),
    "runDir": str(private),
    "attemptDir": str(attempt_dir),
    "eventWindow": core.FAILURE_DIAGNOSTIC_EVENT_LIMIT,
    "eventsEmitted": event_total,
    "attemptKey": resource["acpx_attempt_key"],
}

bundle_path = audit.get("diagnosticsPath")
if isinstance(bundle_path, str) and Path(bundle_path).is_file():
    bundle = json.loads(Path(bundle_path).read_text(encoding="utf-8"))
    report["bundleName"] = Path(bundle_path).name
    report["bundleMode"] = oct(Path(bundle_path).stat().st_mode & 0o777)
    report["bundleBytes"] = Path(bundle_path).stat().st_size
    report["bundleInRunDir"] = Path(bundle_path).parent == private
    report["bundleReason"] = bundle.get("reason")
    report["bundleOperationId"] = bundle.get("operationId")
    report["bundleCaptureStatus"] = (bundle.get("workerResult") or {}).get("output", {}).get("capture", {}).get("captureStatus")
    report["bundleStderrTail"] = str(bundle.get("stderrTail") or "")[:200]
    report["bundleRecentEventCount"] = len(bundle.get("recentEvents") or [])

capture_path = audit.get("captureRetainedPath")
if isinstance(capture_path, str) and Path(capture_path).is_file():
    lines = Path(capture_path).read_text(encoding="utf-8").splitlines()
    report["captureName"] = Path(capture_path).name
    report["captureLines"] = len(lines)
    report["captureMode"] = oct(Path(capture_path).stat().st_mode & 0o777)
    report["captureFirstSeq"] = json.loads(lines[0])["seq"] if lines else None
    report["captureLastSeq"] = json.loads(lines[-1])["seq"] if lines else None

print(json.dumps(report, sort_keys=True))
atexit.register(_stop_worker)