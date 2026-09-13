"""Bounded real-adapter result proof. Default is a dry run; --execute spends provider credits."""
import argparse
import json
import os
import secrets
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[2]
REPO = PACKAGE.parents[1]


def snapshot_changes(resource):
    """Top-level JSON keys that differ between a changed configuration snapshot and its source; no values."""
    changes = []
    for item in resource.get("provider_links", []):
        if item.get("kind") != "snapshot":
            continue
        link = Path(str(item["link"]))
        # Link records carry no source path; the Claude snapshots come from these two files.
        home = Path(os.environ.get("HOME", str(Path.home())))
        source = {"settings.json": home / ".claude" / "settings.json", ".claude.json": home / ".claude.json"}.get(link.name)
        if source is None or not link.is_file() or not source.is_file():
            continue
        try:
            before = json.loads(source.read_text(encoding="utf-8"))
            after = json.loads(link.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(before, dict) or not isinstance(after, dict):
            continue
        added = sorted(set(after) - set(before))
        removed = sorted(set(before) - set(after))
        changed = sorted(key for key in set(before) & set(after) if before[key] != after[key])
        if added or removed or changed:
            changes.append({"file": link.name, "addedKeys": added, "removedKeys": removed, "changedKeys": changed})
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--execute", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--preflight", action="store_true")
    parser.add_argument("--pi-model", default="alibaba/qwen3.8-flash")
    parser.add_argument("--codex-model", default="openai-codex/gpt-6-astra")
    parser.add_argument("--claude-model", default="claude-code/claude-opus-5")
    parser.add_argument("--evidence-dir", type=Path, default=REPO / "agent-output" / "runtime-result-probe")
    parser.add_argument("--agents", default="pi,codex,claude", help="comma-separated subset of pi, codex, claude to probe (default all three)")
    args = parser.parse_args()
    selected = [agent.strip() for agent in args.agents.split(",") if agent.strip()]
    if not selected or any(agent not in ("pi", "codex", "claude") for agent in selected):
        parser.error("--agents must name a subset of pi, codex, claude")
    models = {agent: model for agent, model in (("pi", args.pi_model), ("codex", args.codex_model), ("claude", args.claude_model)) if agent in selected}
    if not args.codex_model.startswith("openai-codex/") or not args.claude_model.startswith("claude-code/") or args.pi_model.startswith(("openai-codex/", "claude-code/")) or "/" not in args.pi_model:
        parser.error("model providers must select their named ACPX agents")
    plan = {"mode": "execute" if args.execute else "preflight" if args.preflight else "dry-run", "models": models, "agents": list(models), "promptsPerAgent": 2, "totalPrompts": 2 * len(models), "promptTimeoutSeconds": 120, "maxTurnsPerPrompt": {"text": 1, "source": 2}, "terminal": False, "evidenceDir": str(args.evidence_dir.resolve()), "spend": "provider-priced; no dollar estimate", "activation": "does not enable runtime-v1"}
    print(json.dumps(plan, indent=2), flush=True)
    if not args.execute and not args.preflight:
        return 0
    blockers = []
    for executable in ["node", "acpx", "agentfs"]:
        if not shutil.which(executable):
            blockers.append(f"missing executable: {executable}")
    with socket.socket() as server:
        try:
            server.bind(("127.0.0.1", 0))
        except OSError as error:
            blockers.append(f"AgentFS loopback prerequisite unavailable: errno {error.errno}")
    for command in [["ps", "-axo", "pid="], ["mount"]]:
        try:
            if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10).returncode != 0:
                blockers.append(f"cleanup inspection unavailable: {command[0]}")
        except (OSError, subprocess.TimeoutExpired):
            blockers.append(f"cleanup inspection unavailable: {command[0]}")
    token = os.environ.get("PI_CLAUDE_OAUTH_TOKEN_FILE")
    if not token or not Path(token).is_file() or Path(token).is_symlink() or Path(token).stat().st_mode & 0o077:
        blockers.append("PI_CLAUDE_OAUTH_TOKEN_FILE must identify a private regular token file")
    if blockers:
        print(json.dumps({"blocked": blockers, "workersStarted": 0}), flush=True)
        return 1
    if args.preflight:
        print(json.dumps({"prerequisitesAvailable": True, "credentialsPreflighted": False, "workersStarted": 0}))
        return 0

    sys.path.insert(0, str(PACKAGE / "scripts"))
    import delegate_core as core
    core.ACTIVE_TRANSPORT = "headless"
    evidence = args.evidence_dir.resolve()
    evidence.mkdir(parents=True, exist_ok=True, mode=0o700)
    evidence.chmod(0o700)
    successful = True
    for agent, model in models.items():
        root = Path(tempfile.mkdtemp(prefix=f"pi-wave-result-{agent}-"))
        resource = None
        original_cwd = Path.cwd()
        result = {"agent": agent, "model": model, "passed": False}
        try:
            base = root / "base"
            private = root / "private"
            base.mkdir(mode=0o700)
            private.mkdir(mode=0o700)
            (base / "probe-source.txt").write_text(f"PROBE_SOURCE_{secrets.token_hex(16)}\n")
            task = private / "task.md"
            task.write_text("Result capture probe; no report file is required.")
            os.chdir(base)
            start_args = core.build_parser().parse_args(["start", str(private), "searcher", "--node", "search", "--model", model, "--access-mode", "read-only", "--no-terminal", "--result-contract", "runtime-v1"])
            resource, environment = core.prepare_acpx_attempt(private, start_args, {"run_label": "result-probe"}, f"probe-{agent}", model, private / "unused-report.json", task, "search", "", "runtime-v1")
            # Headless production resources carry explicit null tab/pane identity (verify_provider_links
            # requires it), and the absence audit reads the tab through str(), so the keys must exist.
            resource.update({"run_dir": str(private), "agent": f"probe-{agent}", "role": "searcher", "node": "search", "model": model, "tab": None, "pane": None})
            result_path = private / "probe-result.json"
            invocation = [shutil.which("agentfs"), "run", "--session", resource["agentfs_session"], "--no-default-allows", "--allow", str(private), shutil.which("node"), "--experimental-strip-types", str(PACKAGE / "test" / "support" / "runtime-result-probe.ts"), str(result_path)]
            run = subprocess.Popen(invocation, cwd=base, env={**os.environ, **environment}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                run.wait(timeout=330)
            except subprocess.TimeoutExpired:
                os.killpg(run.pid, signal.SIGKILL)
                run.wait(timeout=10)
                raise
            if result_path.is_file():
                result.update(json.loads(result_path.read_text()))
            result["processExitCode"] = run.returncode
            if result.get("sessionClosed"):
                # The worker proved session_closed; a later structured cancel would only fail on the
                # closed session, so teardown must not attempt it.
                resource["session_closure"] = "close-proved"
                Path(resource["acpx_cancel_script"]).unlink(missing_ok=True)
            try:
                result["providerBoundaryVerified"] = core.verify_provider_links(resource)
                result["configurationSelfWrites"] = core.configuration_self_writes(resource)
            except core.DelegateError as error:
                result["providerBoundaryVerified"] = False
                result["providerBoundaryFailure"] = core.without_target_paths(str(error))
                result["changedSnapshots"] = snapshot_changes(resource)
            result["passed"] = run.returncode == 0 and result.get("checksPassed") is True and result.get("providerBoundaryVerified") is True
        except Exception as error:
            result["failureType"] = type(error).__name__
            result["failure"] = core.without_target_paths(str(error))
        finally:
            os.chdir(original_cwd)
            if resource is not None:
                try:
                    failures = core.abort_acpx_attempt(resource)
                    result["cleanupFailures"] = failures
                    if not failures:
                        for command in [["ps", "-axo", "pid="], ["mount"]]:
                            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                        core.verify_cleanup_absence(private, resource)
                    result["cleanupVerified"] = not failures
                    result["cleanupFailureCount"] = len(failures)
                except Exception as error:
                    result["cleanupVerified"] = False
                    result["cleanupFailureType"] = type(error).__name__
                    result["cleanupFailure"] = core.without_target_paths(str(error))
                    # Record which absence checks failed and how many owned processes remained,
                    # without copying process command lines that carry private paths.
                    processes = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, check=False, timeout=10)
                    mounts = subprocess.run(["mount"], capture_output=True, text=True, check=False, timeout=10)
                    inventory = core.cleanup_absence_inventory(resource, "", False, False, processes.stdout, mounts.stdout)
                    result["cleanupInventory"] = {key: value for key, value in inventory.items() if isinstance(value, bool)}
                    result["ownedProcessCount"] = len(inventory.get("ownedProcessMatches", []))
            else:
                result["cleanupVerified"] = True
            result["passed"] = result["passed"] and result["cleanupVerified"]
            if result["cleanupVerified"]:
                shutil.rmtree(root)
            else:
                result["retainedPrivateRoot"] = str(root)
            output = evidence / f"{agent}.json"
            core.write_private(output, json.dumps(result, indent=2) + "\n")
            successful = successful and result["passed"]
            print(json.dumps({"agent": agent, "passed": result["passed"], "evidence": str(output)}), flush=True)
    return 0 if successful else 1


if __name__ == "__main__":
    sys.exit(main())
