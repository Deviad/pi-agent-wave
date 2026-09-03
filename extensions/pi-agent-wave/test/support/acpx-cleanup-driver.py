#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

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
    def cancel(_resource: dict[str, object]) -> dict[str, object]:
        if case == "cancel":
            raise module.DelegateError("cancel failed")
        if case == "close":
            raise module.DelegateError("session_closed failed")
        return {"cancelled": True, "structuredCancelled": True, "closed": True, "noSession": True}
    def verify(_resource: dict[str, object]) -> bool:
        if case == "provider-link":
            raise module.DelegateError("provider link removal failed")
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
        return {"case": case, "failures": failures, "failed": bool(failures)}
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


mode, case = sys.argv[1:3]
if mode == "abort": result = abort_case(case)
elif mode == "default-cancel": result = default_cancel_case()
elif mode == "persistence": result = persistence_case()
elif mode == "inventory": result = inventory_case(case)
else: raise ValueError(mode)
print(json.dumps(result, sort_keys=True))
