#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py"
spec = importlib.util.spec_from_file_location("herdr_delegate", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def resource(root: Path) -> dict[str, object]:
    attempt = root / "attempt"
    attempt.mkdir(parents=True, exist_ok=True)
    return {
        "attempt_dir": str(attempt),
        "run_dir": str(root),
        "pane": "pane-owned",
        "tab": "tab-owned",
        "agent": "agent-owned",
        "acpx_session": "session-owned",
        "acpx_session_id": "session-owned",
        "acpx_record_id": "session-owned",
        "acpx_attempt_key": "run:operation:review:0:0:model:codex",
        "acpx_home": str(attempt / "acpx-home"),
        "agentfs_home": str(attempt / "agentfs-home"),
        "agentfs_db_path": str(attempt / "agentfs-home" / "delta.db"),
        "provider_links": [],
    }


def abort_case(case: str) -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="acpx-cleanup-driver-"))
    owned = resource(root)
    attempt = Path(str(owned["attempt_dir"]))
    # Seed a real owned resource wherever the case claims cleanup fails closed on one, so an
    # already-absent resource is never what proves the safeguard.
    if case in ("cancel", "close"):
        script = attempt / "cancel-acpx.sh"
        script.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        script.chmod(0o700)
        owned["acpx_cancel_script"] = str(script)
    if case == "provider-link":
        target = root / "credential-target"
        target.write_text("placeholder-not-a-secret", encoding="utf-8")
        link = attempt / "auth-link"
        link.symlink_to(target)
        owned["provider_links"] = [{"kind": "file", "link": str(link), "keySet": '["openai"]', "sha256": "0" * 64, "mode": "0o600"}]

    def cancel(_resource: dict[str, object]) -> dict[str, object]:
        if case == "cancel":
            raise module.DelegateError("cancel failed")
        if case == "close":
            raise module.DelegateError("session_closed failed")
        return {"cancelled": True, "structuredCancelled": True, "closed": True, "noSession": True}
    def verify(_resource: dict[str, object]) -> bool:
        if case == "provider-link":
            raise module.DelegateError(f"materialized provider credential is missing: {root / 'credential-target'}")
        return True
    def command(_args: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess([], 1 if case == "herdr-agent-release" else 0, "", "release failed" if case == "herdr-agent-release" else "")
    def close_tab(_run_dir: Path, _tab: str) -> None:
        if case == "herdr-tab-release":
            raise module.DelegateError("tab release failed")
    def remove(path: Path) -> None:
        if case != "attempt-directory" and path.exists():
            shutil.rmtree(path)
    try:
        failures = module.abort_acpx_attempt(owned, cancel_attempt=cancel, provider_verifier=verify, command_runner=command, tab_closer=close_tab, remove_tree=remove)
        return {
            "case": case,
            "failures": failures,
            "failed": bool(failures),
            "credentialPathLeaked": case == "provider-link" and str(root) in " ".join(failures),
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


def diagnostics_case() -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="acpx-diagnostics-driver-"))
    owned = resource(root)
    owned["run_id"] = "run-diagnostic"
    owned["operation_id"] = "op-diagnostic"
    owned["node"] = "implement"
    owned["selected_model"] = "alibaba/some-model"
    attempt = Path(str(owned["attempt_dir"]))
    # Built at runtime so the repository never contains a credential-shaped literal.
    setup_token = "sk-ant-" + "oat" + ("A" * 34)
    bearer = "Bearer " + ("z" * 30)
    bare_key = "sk-" + "a1." * 22 + "xyz"
    account_email = "someone@example.com"
    account_id = "acct-0123456789"
    (attempt / "worker-result.json").write_text(json.dumps({
        "schemaVersion": 1,
        "processExitCode": 1,
        "terminal": {"kind": "failed", "sessionId": "session-owned"},
        "note": "token leaked here: " + setup_token,
    }) + "\n", encoding="utf-8")
    (attempt / "worker.stderr.txt").write_text(
        "line one\nAuthorization: " + bearer + "\nOPENAI_API_KEY=supersecretvalue123\n" + ("e" * 9000) + "\nprovider rejected " + bare_key + "\n",
        encoding="utf-8",
    )
    (attempt / "worker.stdout.ndjson").write_text(
        "{\"kind\":\"failed\",\"detail\":\"RUNTIME QUEUE_RUNTIME_PROMPT_FAILED\"}\n"
        + json.dumps({"method": "_auth/status_update", "params": {"authStatus": {"kind": "account", "account": {"email": account_email, "account_id": account_id, "label": "ChatGPT Prolite"}}}}) + "\n"
        + ("{\"kind\":\"noise\"}\n" * 30),
        encoding="utf-8",
    )
    def cancel(_resource: dict[str, object]) -> dict[str, object]:
        return {"cancelled": True, "structuredCancelled": True, "closed": True, "noSession": True}
    def remove(path: Path) -> None:
        if path.exists():
            shutil.rmtree(path)
    try:
        failures = module.abort_acpx_attempt(owned, cancel_attempt=cancel, provider_verifier=lambda _r: True, command_runner=lambda _a, **_k: subprocess.CompletedProcess([], 0, "", ""), tab_closer=lambda _r, _t: None, remove_tree=remove)
        bundles = sorted(root.glob("failure-*.json"))
        bundle = json.loads(bundles[0].read_text(encoding="utf-8")) if bundles else {}
        raw = bundles[0].read_text(encoding="utf-8") if bundles else ""
        return {
            "case": "diagnostics",
            "failures": failures,
            "bundleCount": len(bundles),
            "bundleName": bundles[0].name if bundles else None,
            "mode": oct(bundles[0].stat().st_mode & 0o777) if bundles else None,
            "attemptRemoved": not attempt.exists(),
            "terminalKind": bundle.get("terminalKind"),
            "processExitCode": bundle.get("processExitCode"),
            "selectedModel": bundle.get("selectedModel"),
            "operationId": bundle.get("operationId"),
            "leakedSetupToken": setup_token in raw,
            "leakedBearer": bearer in raw,
            "leakedApiKeyAssignment": "supersecretvalue123" in raw,
            "leakedBareProviderKey": bare_key in raw,
            "leakedAccountEmail": account_email in raw,
            "leakedAccountId": account_id in raw,
            "eventsParseAsJson": all(isinstance(item, dict) for item in bundle.get("recentEvents", [])),
            "redactionMarkerSeen": "[redacted]" in raw,
            "stderrTailBytes": len(str(bundle.get("stderrTail", ""))),
            "recentEventCount": len(bundle.get("recentEvents", [])),
            "environmentPersisted": "worker_environment" in raw,
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


SCRIPTS = MODULE_PATH.parent
CLI = SCRIPTS / "headless_delegate.py"
CREDENTIAL_TARGET = "credential-target"


def teardown_case(case: str) -> dict[str, object]:
    """Drive the real headless CLI teardown three times over real disposable resources.

    `repeat-teardown` starts where a completed teardown leaves an attempt: no attempt tree, cancel
    launcher, credential or AgentFS-shaped database at all. `partial-teardown` keeps the tree and the
    shaped database but the launcher and materialized credential are already gone. `survivor` keeps a
    provider link to a real credential target outside the attempt tree, which no cleanup removes.

    The owned-process probe matches by command-line substring, so the fixture session name is unique
    per run: an unrelated host process that merely mentions a shared name would otherwise pin the
    audit to the machine running the suite.
    """
    session = f"dg-probe-{uuid.uuid4().hex[:10]}"
    env = {key: value for key, value in os.environ.items() if not key.startswith("HERDR_")}
    root = Path(tempfile.mkdtemp(prefix="acpx-teardown-"))
    init = subprocess.run([sys.executable, str(CLI), "init", f"teardown-{case}"], capture_output=True, text=True, env=env, cwd=str(root), check=False)
    if init.returncode != 0:
        return {"case": case, "skipped": True, "reason": (init.stderr or init.stdout).strip()[:200]}
    run_dir = Path(init.stdout.strip())
    agent = "dg_probe_auditor_0001"
    attempt = run_dir / "acpx" / agent
    acpx_home = attempt / "acpx-home"
    agentfs_home = attempt / "agentfs-home"
    acpx_home.mkdir(parents=True)
    agentfs_home.mkdir(parents=True)
    credential = acpx_home / "auth.json"
    credential.write_text('{"alibaba":{"type":"api_key","key":"placeholder-not-a-secret"}}\n', encoding="utf-8")
    credential.chmod(0o600)
    launcher = attempt / "cancel-acpx.sh"
    launcher.write_text("#!/bin/sh\nprintf '%s\\n' '{\"action\":\"cancel_attempt\"}'\n", encoding="utf-8")
    launcher.chmod(0o700)
    database = agentfs_home / ".agentfs" / "run" / "dg-audit-probe"
    database.mkdir(parents=True)
    (database / "delta.db").write_bytes(b"not-a-real-db")
    target = root / CREDENTIAL_TARGET
    target.write_text("placeholder-not-a-secret", encoding="utf-8")
    survivor_link = root / "auth-link"
    state_path = run_dir / "state.json"
    registered = credential
    try:
        if case == "survivor":
            # Outside the attempt tree, so removing that tree cannot hide the surviving resource.
            survivor_link.symlink_to(target)
            registered = survivor_link
        elif case == "partial-teardown":
            credential.unlink()
            launcher.unlink()
        elif case == "repeat-teardown":
            shutil.rmtree(attempt)
        else:
            raise ValueError(case)
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["resources"] = [{
            "execution": "acpx-agentfs",
            "run_id": "run_probe",
            "operation_id": "op_probe",
            "agent": agent,
            "node": "audit",
            "role": "auditor",
            "acp_agent": "codex",
            "model": "alibaba/some-model",
            "tier": "balanced",
            "acpx_session": session,
            "acpx_record_id": session,
            "acpx_attempt_key": "run:op:audit:0:0:model:codex",
            "agentfs_session": session,
            "agentfs_home": str(agentfs_home),
            "acpx_home": str(acpx_home),
            "agentfs_db_path": str(agentfs_home / f".agentfs/run/{session}/delta.db"),
            "attempt_dir": str(attempt),
            "worker_result": str(attempt / "worker-result.json"),
            "acpx_cancel_script": str(launcher),
            "provider_links": [{"kind": "file", "link": str(registered), "keySet": '["alibaba"]', "sha256": "0" * 64, "mode": "0o600"}],
            "pane": None,
            "tab": None,
            "report_repair_attempts": 0,
        }]
        state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        passes = []
        for _ in range(3):
            result = subprocess.run([sys.executable, str(CLI), "cleanup", str(run_dir)], capture_output=True, text=True, env=env, cwd=str(root), check=False)
            passes.append({
                "exit": result.returncode,
                "evidence": len(list(run_dir.glob("cleanup-*.json"))),
                "output": (result.stdout + result.stderr)[:600],
                "missingNoise": "No such file or directory" in (result.stdout + result.stderr) or "is missing" in (result.stdout + result.stderr),
            })
        return {
            "case": case,
            "skipped": False,
            "exits": [entry["exit"] for entry in passes],
            "evidenceCounts": [entry["evidence"] for entry in passes],
            "closure": [json.loads(path.read_text(encoding="utf-8")).get("sessionClosureEvidence") for path in sorted(run_dir.glob("cleanup-*.json"))],
            "targetPathLeaked": any(str(root) in entry["output"] for entry in passes),
            "missingNoise": [entry["missingNoise"] for entry in passes],
            "linkRemained": survivor_link.is_symlink(),
            "attemptRemained": attempt.exists(),
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(run_dir, ignore_errors=True)


def absent_attempt_case() -> dict[str, object]:
    """A settled attempt has no attempt directory, so cleanup must not write a failure bundle."""
    root = Path(tempfile.mkdtemp(prefix="absent-attempt-"))
    owned = resource(root)
    Path(str(owned["attempt_dir"])).rmdir()
    try:
        module.abort_acpx_attempt(
            owned,
            cancel_attempt=lambda _r: {"cancelled": True, "structuredCancelled": True, "closed": True, "noSession": True},
            provider_verifier=lambda _r: True,
            command_runner=lambda _a, **_k: subprocess.CompletedProcess([], 0, "", ""),
            tab_closer=lambda _r, _t: None,
            remove_tree=lambda path: None,
        )
        return {"bundles": sorted(path.name for path in root.glob("failure-*.json"))}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def default_cancel_case() -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="acpx-default-cancel-"))
    owned = resource(root)
    script = root / "cancel-acpx.sh"
    script.write_text("#!/bin/sh\nprintf '%s\\n' '" + json.dumps({"action": "cancel_attempt", "sessionName": owned["acpx_session"], "recordId": owned["acpx_record_id"], "attemptKey": owned["acpx_attempt_key"], "cancelled": True, "structuredCancelled": True, "closed": True, "noSession": True}, separators=(",", ":")) + "'\n")
    script.chmod(0o700)
    owned["acpx_cancel_script"] = str(script)
    try:
        result = module.run_structured_cancel(owned)
        return {"case": "default-cancel", "passed": result.get("noSession") is True}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def persistence_case() -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="acpx-cleanup-persist-"))
    owned = resource(root)
    shutil.rmtree(Path(str(owned["attempt_dir"])))
    original_run = module.run
    module.run = lambda args, **kwargs: subprocess.CompletedProcess(args, 1 if args[1:3] in (["pane", "get"], ["agent", "get"]) else 0, "", "")
    try:
        try:
            module.verify_cleanup_absence(root, owned, evidence_writer=lambda _path, _text: (_ for _ in ()).throw(OSError("persistence failed")))
        except OSError as error:
            return {"case": "cleanup-evidence", "failed": True, "error": str(error)}
        return {"case": "cleanup-evidence", "failed": False}
    finally:
        module.run = original_run
        shutil.rmtree(root, ignore_errors=True)


def inventory_case(case: str) -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix="acpx-cleanup-inventory-"))
    owned = resource(root)
    shutil.rmtree(Path(str(owned["attempt_dir"])))
    tabs = ""
    pane_exists = False
    agent_exists = False
    processes = ""
    mounts = ""
    if case == "tab": tabs = "tab-owned"
    elif case == "pane": pane_exists = True
    elif case == "agent": agent_exists = True
    elif case == "queue-owner": processes = "123 acpx queue session-owned"
    elif case == "acpx-session-files": Path(str(owned["acpx_home"])).mkdir(parents=True)
    elif case == "agentfs-mount": mounts = f"agentfs on {owned['agentfs_home']}"
    elif case == "agentfs-server": processes = "124 agentfs run session-owned"
    elif case == "agentfs-database":
        path = Path(str(owned["agentfs_db_path"])); path.parent.mkdir(parents=True); path.write_text("db")
    elif case == "agentfs-home": Path(str(owned["agentfs_home"])).mkdir(parents=True)
    elif case == "provider-link":
        target = root / "credential"; target.write_text("x")
        link = root / "provider-link"; link.symlink_to(target)
        owned["provider_links"] = [str(link)]
    elif case == "report-repair-child": processes = f"125 report repair {owned['attempt_dir']}"
    elif case == "attempt-directory": Path(str(owned["attempt_dir"])).mkdir(parents=True)
    else: raise ValueError(case)
    try:
        inventory = module.cleanup_absence_inventory(owned, tabs, pane_exists, agent_exists, processes, mounts)
        return {"case": case, "falseFields": sorted(key for key, value in inventory.items() if value is False)}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def closure_case(case: str) -> dict[str, object]:
    """Pin that session closure in the audit comes from an observation, never from a literal.

    `unobserved` leaves a real ACPX session file behind with no cancellation and no verified close,
    so the audit must report the session as not closed and refuse to write the audit. `observed`
    removes everything and records a verified close, so the audit passes and says which observation
    proved closure.
    """
    root = Path(tempfile.mkdtemp(prefix="acpx-closure-"))
    owned = resource(root)
    run_dir = root / "run"
    run_dir.mkdir()
    attempt = Path(str(owned["attempt_dir"]))
    if case == "unobserved":
        # A live session file plus an owner process line: the session is demonstrably not closed.
        (attempt / "acpx-home").mkdir(parents=True)
        (attempt / "acpx-home" / "session-owned.json").write_text("{}", encoding="utf-8")
        owned["acpx_attempt_key"] = "run:op:audit:0:0:model:codex"
        evidence_error = None
        written = run_dir / f"cleanup-{module.slugify(str(owned['agent']))}.json"
        try:
            module.verify_cleanup_absence(run_dir, owned, evidence_writer=lambda path, text: path.write_text(text))
        except module.DelegateError as error:
            evidence_error = str(error)
        return {
            "case": case,
            "failed": evidence_error is not None,
            "reason": evidence_error,
            "evidenceWritten": written.exists(),
        }
    if case == "observed":
        shutil.rmtree(attempt)
        owned["session_closure"] = "close-proved"
        evidence_path = module.verify_cleanup_absence(run_dir, owned, evidence_writer=lambda path, text: path.write_text(text))
        evidence = json.loads(Path(evidence_path).read_text(encoding="utf-8"))
        return {"case": case, "failed": False, "sessionClosed": evidence.get("sessionClosed"), "closure": evidence.get("sessionClosureEvidence")}
    raise ValueError(case)


mode, case = sys.argv[1:3]
if mode == "abort": result = abort_case(case)
elif mode == "diagnostics": result = diagnostics_case()
elif mode == "absent-attempt": result = absent_attempt_case()
elif mode == "teardown": result = teardown_case(case)
elif mode == "closure": result = closure_case(case)
elif mode == "default-cancel": result = default_cancel_case()
elif mode == "persistence": result = persistence_case()
elif mode == "inventory": result = inventory_case(case)
else: raise ValueError(mode)
print(json.dumps(result, sort_keys=True))
