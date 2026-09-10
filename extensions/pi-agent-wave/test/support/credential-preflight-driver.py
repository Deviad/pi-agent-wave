#!/usr/bin/env python3
"""Drive the real credential preflight with a fake command runner.

Loads `scripts/delegate_core.py` directly and calls `preflight_provider_credential` and
`materialize_pi_credentials` with an injected `command_runner`, so the production branches run
offline. No provider call and no network happens here, and every key in a fixture is a literal
placeholder, never credential material from any real store.

The shapes handed back imitate `pi auth check --json` output and the plain-text form it takes
without `--json`, because the difference between those two is what makes the flag load-bearing.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py"
spec = importlib.util.spec_from_file_location("delegate_core_under_test", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

DECOY_HOME = "/decoy/home"
DECOY_AGENT_DIR = "/decoy/agent-dir"
PLACEHOLDER_KEY = "test-placeholder-not-a-real-key"


class FakeRunner:
    """Record every argv and env the preflight passes, and answer from the case script."""

    def __init__(self, check_result, key_result=None):
        self.check_result = check_result
        self.key_result = key_result
        self.calls: list[dict] = []

    def __call__(self, argv, check=True, env=None):
        self.calls.append({"argv": list(argv), "env": dict(env or {})})
        target = self.key_result if "print-api-key" in argv else self.check_result
        if isinstance(target, Exception):
            raise target
        return target


def completed(argv, stdout, returncode):
    import subprocess

    return subprocess.CompletedProcess(argv, returncode, stdout, "")


def build(case: str) -> dict:
    root = Path(tempfile.mkdtemp(prefix="credential-preflight-"))
    try:
        real_home = root / "home"
        agent_dir = real_home / ".pi" / "agent"
        agent_dir.mkdir(parents=True)
        pi_agent_dir = root / "attempt" / "providers" / "pi-agent"
        pi_agent_dir.mkdir(parents=True)

        # Poison the caller's environment: the preflight must build its own env from real_home
        # and never inherit these, which is the enforceable half of "never check a different
        # agent's store".
        module.os.environ["HOME"] = DECOY_HOME
        module.os.environ["PI_CODING_AGENT_DIR"] = DECOY_AGENT_DIR

        def run_check(stdout, returncode=0, key_result=None):
            # An Exception is passed through bare so the production `except Exception` branch runs,
            # rather than being wrapped in a result that merely looks like unparsable output.
            check_result = stdout if isinstance(stdout, Exception) else completed(["pi", "auth", "check"], stdout, returncode)
            runner = FakeRunner(check_result, key_result)
            result = module.preflight_provider_credential("anthropic", "anthropic/claude-test", real_home, command_runner=runner)
            call = runner.calls[0]
            return {
                "authType": result[0],
                "reason": result[1],
                "argv": call["argv"],
                "envHome": call["env"].get("HOME"),
                "envAgentDir": call["env"].get("PI_CODING_AGENT_DIR"),
            }

        if case == "ready-json":
            return run_check('{"status":"ready","provider":"anthropic","authType":"oauth"}')
        if case == "plain-ready":
            return run_check("ready")
        if case == "not-ready-reason":
            return run_check('{"status":"not_ready","reason":"no credential configured"}')
        if case == "ready-but-failed-exit":
            return run_check('{"status":"ready","provider":"anthropic","authType":"oauth"}', returncode=1)
        if case == "runner-raised":
            return run_check(OSError("pi binary missing"))

        def run_materialize(stdout, seed_live_entry):
            if seed_live_entry:
                (agent_dir / "auth.json").write_text(
                    json.dumps({"anthropic": {"type": "api_key", "key": PLACEHOLDER_KEY}}), encoding="utf-8"
                )
            live_before = None
            if (agent_dir / "auth.json").exists():
                live_before = (agent_dir / "auth.json").read_bytes()
            # With a seeded live entry the code must not need `print-api-key` at all; without one,
            # a failing lookup is what turns "no usable credential" into a raised preflight error.
            # Always a failing lookup: when a live entry exists the preflight must not need this
            # call at all, so a success here would mask a regression that consults it anyway.
            key_result = completed(["pi", "auth", "print-api-key"], "", 1)
            runner = FakeRunner(completed(["pi", "auth", "check"], stdout, 0), key_result)
            try:
                link = module.materialize_pi_credentials(pi_agent_dir, real_home, "anthropic", "anthropic/claude-test", command_runner=runner)
                destination = Path(link["link"])
                return {
                    "raised": None,
                    "link": str(destination.relative_to(root)),
                    "mode": link["mode"],
                    "isSymlink": destination.is_symlink(),
                    "keySet": link["keySet"],
                    "liveUnchanged": (agent_dir / "auth.json").read_bytes() == live_before,
                    "callCount": len(runner.calls),
                    "checkCall": runner.calls[0]["argv"],
                }
            except module.DelegateError as error:
                return {"raised": str(error), "liveUnchanged": True, "checkCall": runner.calls[0]["argv"]}

        if case == "override-not-ready-but-live-entry":
            return run_materialize('{"status":"not_ready","reason":"no credential configured"}', seed_live_entry=True)
        if case == "no-usable-credential":
            return run_materialize('{"status":"not_ready","reason":"no credential configured"}', seed_live_entry=False)
        raise AssertionError(f"unknown case: {case}")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def run_live(provider: str) -> dict:
    """Run one real `pi auth check` through the production function, read-only.

    Uses the caller's real home so the answer describes the store the executing agent reads, and
    reports only status and authType: no key material, no file contents, nothing that could put a
    credential into a log. Only reached when PI_RUN_LIVE_PREFLIGHT=1.
    """
    real_home = Path(module.os.environ.get("HOME") or str(Path.home()))
    store = real_home / ".pi" / "agent" / "auth.json"
    before = store.read_bytes() if store.is_file() else b""
    auth_type, reason = module.preflight_provider_credential(provider, f"{provider}/live-probe", real_home)
    after = store.read_bytes() if store.is_file() else b""
    return {"provider": provider, "authType": auth_type, "reason": reason, "storeUnchanged": before == after}


if __name__ == "__main__":
    argument = sys.argv[1]
    if argument.startswith("live:"):
        print(json.dumps(run_live(argument.split(":", 1)[1])))
    else:
        print(json.dumps(build(argument)))