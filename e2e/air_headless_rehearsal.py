#!/usr/bin/env python3
"""Stage, restore, and finalize the real JetBrains Air headless-control rehearsal."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = Path.home() / "Library" / "Application Support" / "JetBrains" / "Air" / "acp.json"
STATE = Path("/private/tmp/pi-agent-wave-air-e2e-state.json")
AGENT_NAME = "Pi Wave Headless E2E"
NPX = Path("/Users/spotted/.nvm/versions/node/v22.16.0/bin/npx")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private_write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def stage(config_path: Path, state_path: Path, install: bool) -> dict[str, object]:
    if not config_path.exists():
        raise RuntimeError(f"Air ACP config missing: {config_path}")
    before = config_path.read_bytes()
    config = json.loads(before)
    if AGENT_NAME in config.get("agent_servers", {}):
        raise RuntimeError(f"{AGENT_NAME} already exists")
    workspace = Path(tempfile.mkdtemp(prefix="pi-wave-air-e2e-", dir="/private/tmp"))
    workspace.chmod(0o700)
    agent_dir = workspace / "agent"
    agent_dir.mkdir(mode=0o700)
    source_auth = Path.home() / ".pi" / "agent" / "auth.json"
    if source_auth.exists():
        (agent_dir / "auth.json").symlink_to(source_auth)
    routing = {
        "default_tier": "strong",
        "tiers": {"strong": {"models": ["openai-codex/gpt-5.6-sol"], "thinking": "low", "session": True}},
        "roles": {role: {"tier": "strong"} for role in ["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"]},
    }
    (agent_dir / "model-routing.jsonc").write_text(json.dumps(routing), encoding="utf-8")
    source_models = Path.home() / ".pi" / "agent" / "models.json"
    if source_models.exists():
        shutil.copy2(source_models, agent_dir / "models.json")
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir)}
    if install:
        result = subprocess.run(["pi", "install", str(ROOT / "extensions" / "pi-agent-wave")], env=env, text=True, capture_output=True, timeout=180)
        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout)
    entry = {
        "command": str(NPX),
        "args": ["-y", "pi-acp@0.0.31"],
        "env": {
            "PI_CODING_AGENT_DIR": str(agent_dir),
            "DELEGATE_GRAPH_DB": str(workspace / "graph.db"),
            "DELEGATE_GRAPH_LEDGER_BASE": str(workspace / "output"),
            "PATH": os.environ.get("PATH", ""),
        },
    }
    config.setdefault("agent_servers", {})[AGENT_NAME] = entry
    backup = workspace / "acp.json.before"
    backup.write_bytes(before)
    backup.chmod(0o600)
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    state = {
        "schemaVersion": 1,
        "configPath": str(config_path),
        "configMode": oct(config_path.stat().st_mode & 0o777),
        "beforeSha256": hashlib.sha256(before).hexdigest(),
        "backupPath": str(backup),
        "workspace": str(workspace),
        "agentDir": str(agent_dir),
        "installed": install,
    }
    private_write(state_path, state)
    return state


def restore(state_path: Path) -> dict[str, object]:
    state = json.loads(state_path.read_text(encoding="utf-8"))
    config = Path(state["configPath"])
    backup = Path(state["backupPath"])
    config.write_bytes(backup.read_bytes())
    config.chmod(int(state["configMode"], 8))
    restored = sha(config) == state["beforeSha256"]
    return {"restored": restored, "config": str(config), "workspace": state["workspace"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["stage", "restore"])
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--state", type=Path, default=STATE)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    result = stage(args.config, args.state, args.install) if args.action == "stage" else restore(args.state)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
