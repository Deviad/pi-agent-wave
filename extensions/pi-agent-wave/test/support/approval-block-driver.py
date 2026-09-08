#!/usr/bin/env python3
"""Feed real ACPX denial shapes through the production worker-result reader.

Each case writes a disposable attempt directory plus a worker-result.json in the
shape the installed acpx CLI actually emits, then calls the production
`wait_for_settled_agent` and reports the message it raises. No model request and
no provider call happens here; the shapes come from acpx's own exit-code table and
`applyPermissionExitCode` behaviour.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py"
spec = importlib.util.spec_from_file_location("herdr_delegate", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ACTIVE_TRANSPORT = "headless"

CASES: dict[str, dict[str, object]] = {
    # acpx sets EXIT_CODES.PERMISSION_DENIED (5) when every permission request in a
    # turn was denied or cancelled, without failing the session terminal.
    "denied-completed": {
        "schemaVersion": 1,
        "processExitCode": 5,
        "status": "idle",
        "permissionDenied": True,
        "terminal": {"kind": "completed", "sessionId": "session-owned", "requestId": "4"},
        "stderr": "PERMISSION_DENIED runtime Permission request denied or cancelled\n",
    },
    # A denied terminal request surfaces as a failed terminal instead.
    "denied-terminal-failed": {
        "schemaVersion": 1,
        "processExitCode": 1,
        "status": "idle",
        "permissionDenied": True,
        "terminal": {"kind": "failed", "sessionId": "session-owned", "requestId": "4"},
        "stderr": "Permission denied for terminal/create\n",
    },
    # The wording recorded in the field, where the block was reported as prose.
    "denied-author-reported": {
        "schemaVersion": 1,
        "processExitCode": 0,
        "status": "ok",
        "terminal": {"kind": "completed", "sessionId": "session-owned", "requestId": "4"},
        "stderr": "Independent test execution was denied twice by the worker approval gate before process creation.\n",
    },
    # A genuine infrastructure failure must keep its transient classification.
    "genuine-runtime-failure": {
        "schemaVersion": 1,
        "processExitCode": 1,
        "status": "failed",
        "terminal": {"kind": "failed", "sessionId": "session-owned", "requestId": "4"},
        "stderr": "QUEUE_RUNTIME_PROMPT_FAILED connection reset by peer\n",
    },
}


def wait_case(case: str) -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="approval-block-driver-"))
    attempt = root / "attempt"
    attempt.mkdir(parents=True)
    payload = CASES[case]
    (attempt / "worker-result.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    resource = {
        "agent": "dg_probe_tester_0001",
        "run_dir": str(root),
        "attempt_dir": str(attempt),
        "execution": "acpx-agentfs",
        "node": "test",
        "worker_result": str(attempt / "worker-result.json"),
        "acpx_session": "session-owned",
        "report": str(attempt / "report.json"),
        "report_repair_attempts": 0,
    }
    try:
        try:
            module.wait_for_settled_agent(root, resource)
            raised = None
        except module.DelegateError as error:
            raised = str(error)
        return {"case": case, "raised": raised, "exitCode": payload["processExitCode"], "terminalKind": (payload["terminal"] or {}).get("kind")}
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    print(json.dumps(wait_case(str(sys.argv[1])), sort_keys=True))
