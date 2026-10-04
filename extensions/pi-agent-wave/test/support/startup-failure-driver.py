#!/usr/bin/env python3
"""Drives a worker whose ACPX session cannot be opened through the shipped settle and cleanup, and reports what survived.

The attempt is the one `prepare_acpx_attempt` builds, with its materialized provider credential; the worker is the
real `acpx-worker.ts`, started by the real headless supervisor; settlement, session close, teardown and the absence
audit are the shipped functions. Only two things are fixtures: ACPX itself, a shim that fails `sessions ensure` with
the live 2026-10-04 error after leaving an npm log and a session record in its home, and the absence of AgentFS,
because the launcher runs the worker directly. Argument: the report path is printed as JSON on stdout.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import signal
import sys
import tempfile
import time

PACKAGE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PACKAGE / "scripts"))

import delegate_core as core

core.ACTIVE_TRANSPORT = "headless"

ENSURE_FAILURE = '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error: Cannot call write after a stream was destroyed","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}'

root = Path(tempfile.mkdtemp(prefix="startup-failure-driver-"))
home = root / "home"
(home / ".codex").mkdir(parents=True)
(home / ".codex" / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "offline-fixture-not-a-credential"}))
os.environ["HOME"] = str(home)
os.environ["CODEX_HOME"] = str(home / ".codex")
os.environ.pop("PI_CLAUDE_OAUTH_TOKEN_FILE", None)
(root / "graph").mkdir(mode=0o700)
os.environ["DELEGATE_GRAPH_DB"] = str(root / "graph" / "graph.db")
os.environ["PI_DRIVER_FIXTURE_SECRET_TOKEN"] = "value-that-must-not-be-retained"

base = root / "base"
base.mkdir()
private = root / "private"
private.mkdir(mode=0o700)
os.chdir(base)

model = "openai-codex/gpt-5.6-sol"
task = private / "task.md"
task.write_text("Fixture task; no model is dispatched.")
task.chmod(0o600)

args = core.build_parser().parse_args(["start", str(private), "thinker", "--node", "thinker_plan", "--model", model, "--access-mode", "read-only"])
resource, environment = core.prepare_acpx_attempt(private, args, {"run_label": "run_startup-fixture"}, "fixture-worker", model, task, "thinker_plan")
attempt_dir = Path(resource["attempt_dir"])
acpx_home = Path(resource["acpx_home"])
resource.update({
    "headless_stdout": str(private / "headless-fixture-worker.stdout"),
    "headless_stderr": str(private / "headless-fixture-worker.stderr"),
    "headless_status": str(private / "headless-fixture-worker.status.json"),
    "stream_token": str(private / "headless-fixture-worker.stream-token"),
    "stream_endpoint": str(private / "headless-fixture-worker.stream-endpoint.json"),
    "run_dir": str(private),
    "agent": "fixture-worker",
    "role": "thinker",
    "node": "thinker_plan",
    "model": model,
    "tab": None,
    "pane": None,
    "worker_pid": None,
})

# ACPX as it behaved live: `sessions ensure` fails after npm started pi-acp; close and status find no session.
shim = root / "acpx-shim"
shim.write_text(
    "#!/bin/sh\n"
    "case \" $* \" in\n"
    "  *' --version '*) echo 0.0.0-shim; exit 0 ;;\n"
    "  *' sessions ensure '*)\n"
    "    mkdir -p \"$HOME/.npm/_logs\" \"$HOME/.acpx/sessions\"\n"
    "    printf '0 verbose cli npm exec pi-acp@^0.0.31\\n1 verbose exit 0\\n' > \"$HOME/.npm/_logs/2026-10-04T10_38_23_000Z-debug-0.log\"\n"
    "    printf '{\"last_agent_exit_code\":0,\"last_agent_disconnect_reason\":\"stdin closed\"}\\n' > \"$HOME/.acpx/sessions/index.json\"\n"
    f"    printf '%s\\n' {shlex.quote(ENSURE_FAILURE)} >&2; exit 1 ;;\n"
    "  *' sessions close '*) echo '{\"action\":\"session_closed\"}'; exit 0 ;;\n"
    "  *' status '*) echo '{\"action\":\"status_snapshot\",\"status\":\"no-session\"}'; exit 0 ;;\n"
    "esac\n"
    "exit 1\n",
    encoding="utf-8",
)
shim.chmod(0o700)
for config_key in ("worker_config", "acpx_cancel_config"):
    config_path = Path(resource[config_key])
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["acpxExecutable"] = str(shim)
    core.write_private(config_path, json.dumps(config, indent=2, sort_keys=True) + "\n")

# The shipped launcher wraps the worker in `agentfs run`; this one runs the same worker without the overlay.
launcher = Path(resource["worker_launcher"])
core.write_private(launcher, "#!/bin/sh\nexec " + " ".join(shlex.quote(part) for part in [core.NODE, "--experimental-strip-types", str(core.ACPX_WORKER)]) + "\n")
launcher.chmod(0o700)
resource["worker_environment"] = environment

worker_pid = core.launch_headless_worker(resource, {**os.environ, **environment})
resource["worker_pid"] = worker_pid
result_path = Path(str(resource["worker_result"]))
deadline = time.monotonic() + 60
while time.monotonic() < deadline and not result_path.exists():
    time.sleep(0.05)

settlement: dict[str, object] = {}
error: str | None = None
try:
    settlement = core.settle_runtime_attempt(private, resource)
except Exception as caught:
    error = f"{type(caught).__name__}: {caught}"
finally:
    try:
        os.killpg(os.getpgid(worker_pid), signal.SIGKILL)
    except OSError:
        pass

bundle_path = private / f"failure-{resource['operation_id']}.json"
bundle = json.loads(bundle_path.read_text(encoding="utf-8")) if bundle_path.is_file() else {}
evidence_dir = Path(str(bundle.get("startupFailureEvidence", "")))
cleanup_path = settlement.get("cleanupEvidencePath")
cleanup = json.loads(Path(str(cleanup_path)).read_text(encoding="utf-8")) if isinstance(cleanup_path, str) and Path(cleanup_path).is_file() else {}
evidence_files = sorted(str(path.relative_to(evidence_dir)) for path in evidence_dir.rglob("*") if path.is_file()) if evidence_dir.is_dir() else []
retained_text = "".join(path.read_text(encoding="utf-8", errors="replace") for path in evidence_dir.rglob("*") if path.is_file()) if evidence_dir.is_dir() else ""

print(json.dumps({
    "root": str(root),
    "graphHome": str(Path(os.environ["DELEGATE_GRAPH_DB"]).parent),
    "runId": resource["run_id"],
    "operationId": resource["operation_id"],
    "transientAttempt": resource["transient_attempt"],
    "model": model,
    "settlementError": error,
    "postSettlementFailures": settlement.get("postSettlementFailures"),
    "bundleReason": bundle.get("reason"),
    "bundleSelectedModel": bundle.get("selectedModel"),
    "bundleStderrTail": bundle.get("stderrTail"),
    "bundleStartupFailureEvidence": bundle.get("startupFailureEvidence"),
    "evidenceFiles": evidence_files,
    "evidenceDirMode": oct(evidence_dir.stat().st_mode & 0o777) if evidence_dir.is_dir() else None,
    "evidenceStderr": (evidence_dir / "worker.stderr.txt").read_text(encoding="utf-8") if (evidence_dir / "worker.stderr.txt").is_file() else None,
    "evidenceEnvironment": json.loads((evidence_dir / "environment.json").read_text(encoding="utf-8")) if (evidence_dir / "environment.json").is_file() else None,
    "evidenceVersions": json.loads((evidence_dir / "versions.json").read_text(encoding="utf-8")) if (evidence_dir / "versions.json").is_file() else None,
    "retainsCredentialValue": "offline-fixture-not-a-credential" in retained_text,
    "retainsSecretEnvironmentValue": "value-that-must-not-be-retained" in retained_text,
    "attemptDirectoryExists": attempt_dir.exists(),
    "acpxHomeExists": acpx_home.exists(),
    "cleanupAttemptDirectoryAbsent": cleanup.get("attemptDirectoryAbsent"),
    "cleanupAcpxSessionFilesAbsent": cleanup.get("acpxSessionFilesAbsent"),
}, sort_keys=True))
