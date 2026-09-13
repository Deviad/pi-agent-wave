#!/usr/bin/env python3
"""Launch and supervise visible Delegate Graph Pi agents in Herdr tabs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
RESOLVER = SCRIPT_DIR / "resolve-model.mjs"
ACPX_WORKER = SCRIPT_DIR / "acpx-worker.ts"
RUNTIME_SETTLE = SCRIPT_DIR / "runtime-settle.ts"
HEADLESS_SUPERVISOR = SCRIPT_DIR / "headless_supervisor.py"
ACPX_CANCEL = SCRIPT_DIR / "acpx-cancel.ts"
ACPX_PLAN = SCRIPT_DIR / "acpx-plan.ts"
NODE = shutil.which("node") or "node"
TMP_ROOT = Path("/tmp").resolve()
RUN_PREFIX = "delegate-graph-herdr-"
WAIT_TIMEOUT_MS = os.environ.get("PI_DELEGATE_WAIT_TIMEOUT_MS", "3600000")
START_READY_TIMEOUT_SECONDS = 10.0
START_RETRY_SECONDS = 0.2
STATE_LOCK_TIMEOUT_SECONDS = 10.0
STATE_LOCK_RETRY_SECONDS = 0.02
STATE_LOCK_ORPHAN_GRACE_SECONDS = 1.0
ACTIVE_TRANSPORT = "herdr"
ROLE_NODES = {
    "thinker": "thinker_plan",
    "implementer": "implement",
    "reviewer": "review",
    "tester": "test",
    "auditor": "audit",
    "searcher": "search",
    "source_search": "source_search",
}


class DelegateError(RuntimeError):
    """A visible delegate could not be launched or verified safely."""


def fail(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def run(
    argv: list[str],
    *,
    check: bool = True,
    capture: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        check=False,
        text=True,
        capture_output=capture,
        env=env,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "no diagnostic output").strip()
        raise DelegateError(f"command failed ({result.returncode}): {argv!r}\n{detail}")
    return result


def require_worker_runtime() -> None:
    for command, expected in (("acpx", "0.13.2"), ("agentfs", "0.6.4")):
        executable = shutil.which(command)
        if executable is None:
            raise DelegateError(f"ACPX-only delegation requires {command} {expected}")
        version = run([executable, "--version"])
        observed = version.stdout + version.stderr
        if expected not in observed:
            raise DelegateError(f"ACPX-only delegation requires {command} {expected}")


def require_herdr() -> None:
    require_worker_runtime()
    if os.environ.get("HERDR_ENV") != "1":
        raise DelegateError("Herdr-visible delegation requires HERDR_ENV=1")
    for variable in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID"):
        if not os.environ.get(variable):
            raise DelegateError(f"Herdr-visible delegation requires {variable}")
    if shutil.which("herdr") is None:
        raise DelegateError("Herdr-visible delegation requires the herdr command")


def using_herdr() -> bool:
    return ACTIVE_TRANSPORT == "herdr"


def integration_status() -> str:
    return run(["herdr", "integration", "status"]).stdout


def pi_integration_current(status: str) -> bool:
    return any(line.startswith("pi: current ") for line in status.splitlines())


def ensure_pi_integration() -> None:
    if pi_integration_current(integration_status()):
        return
    print("[delegate-graph] installing Herdr Pi lifecycle integration", file=sys.stderr)
    run(["herdr", "integration", "install", "pi"], capture=False)
    if not pi_integration_current(integration_status()):
        raise DelegateError(
            "Herdr Pi lifecycle integration is still unavailable after installation"
        )


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "worker"


def require_run_dir(raw_path: str) -> Path:
    run_dir = Path(raw_path).resolve()
    if run_dir.parent != TMP_ROOT or not run_dir.name.startswith(RUN_PREFIX):
        raise DelegateError(f"invalid Herdr delegate run directory: {run_dir}")
    if not run_dir.is_dir() or not (run_dir / "state.json").is_file():
        raise DelegateError(f"incomplete Herdr delegate run directory: {run_dir}")
    return run_dir


def read_state(run_dir: Path) -> dict[str, Any]:
    return json.loads((run_dir / "state.json").read_text(encoding="utf-8"))


def write_private_bytes(path: Path, data: bytes) -> None:
    """Create the file already holding mode 600: O_CREAT mode is umask-masked, so it can never be wider."""
    descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    os.chmod(path, 0o600)


def write_private(path: Path, content: str) -> None:
    write_private_bytes(path, content.encode("utf-8"))


def write_state(run_dir: Path, state: dict[str, Any]) -> None:
    temporary = run_dir / f".state.json.{os.getpid()}.{secrets.token_hex(4)}.tmp"
    write_private(temporary, json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(run_dir / "state.json")
    (run_dir / "state.json").chmod(0o600)


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def clear_orphaned_state_lock(lock: Path) -> bool:
    owner = lock / "owner.json"
    try:
        value = json.loads(owner.read_text())
        pid = int(value["pid"])
    except (FileNotFoundError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        try:
            if time.time() - lock.stat().st_mtime < STATE_LOCK_ORPHAN_GRACE_SECONDS:
                return False
        except FileNotFoundError:
            return True
        pid = -1
    if pid > 0 and process_alive(pid):
        return False
    shutil.rmtree(lock, ignore_errors=True)
    return True


def mutate_state(run_dir: Path, update: Any) -> dict[str, Any]:
    """Serialize one state read-modify-write and retain atomic replacement."""
    lock = run_dir / ".state.lock"
    deadline = time.monotonic() + STATE_LOCK_TIMEOUT_SECONDS
    while True:
        try:
            lock.mkdir(mode=0o700)
            write_private(lock / "owner.json", json.dumps({"pid": os.getpid(), "createdAt": time.time()}))
            break
        except FileExistsError:
            if clear_orphaned_state_lock(lock):
                continue
            if time.monotonic() >= deadline:
                raise DelegateError("timed out acquiring Herdr delegate state lock")
            time.sleep(STATE_LOCK_RETRY_SECONDS)
    try:
        state = read_state(run_dir)
        update(state)
        write_state(run_dir, state)
        return state
    finally:
        shutil.rmtree(lock, ignore_errors=True)


def json_path(payload: str, *keys: str) -> Any:
    value: Any = json.loads(payload)
    for key in keys:
        value = value[key]
    return value


def close_created_tab(run_dir: Path, tab_id: str) -> None:
    if not using_herdr():
        return
    def close(state: dict[str, Any]) -> None:
        if tab_id == state["caller_tab"]:
            raise DelegateError(f"refusing to close caller tab {tab_id}")
        if tab_id in state["closed_tabs"]:
            return
        run(["herdr", "tab", "close", tab_id])
        state["closed_tabs"].append(tab_id)

    mutate_state(run_dir, close)


def command_init(args: argparse.Namespace) -> None:
    if using_herdr():
        require_herdr()
        ensure_pi_integration()
    else:
        require_worker_runtime()
    slug = slugify(args.run_label)
    run_dir = Path(tempfile.mkdtemp(prefix=f"{RUN_PREFIX}{slug}.", dir=TMP_ROOT))
    run_dir.chmod(0o700)
    write_state(
        run_dir,
        {
            "caller_tab": os.environ.get("HERDR_TAB_ID") if using_herdr() else None,
            "transport": ACTIVE_TRANSPORT,
            "closed_tabs": [],
            "resources": [],
            "run_label": args.run_label,
            "run_slug": slug,
        },
    )
    write_private(
        run_dir / "system-prompt.txt",
        "You are a Delegate Graph leaf agent. Execute only the assigned task using "
        "available tools. Do not delegate recursively. Reply with your complete result as "
        "assistant text; the runtime retains it and the supervisor decides it.\n",
    )
    print(run_dir)


# Nodes whose runtime-v1 answer must end with a verdict line; op=decide takes the value the caller reads there.
RUNTIME_VERDICT_NODES: dict[str, tuple[str, ...]] = {"review": ("PASS", "FAIL"), "test": ("GREEN", "NOT_OK"), "audit": ("PASS", "FAIL"), "source_search": ("DONE", "BLOCKED")}


def resolve_tier(tier: str) -> tuple[list[str], str, bool]:
    chain = [
        model.strip()
        for model in run([NODE, str(RESOLVER), tier, "--list"]).stdout.strip().split(",")
        if model.strip()
    ]
    thinking = run([NODE, str(RESOLVER), tier, "--thinking"]).stdout.strip()
    session = run([NODE, str(RESOLVER), tier, "--session"]).stdout.strip() == "true"
    if not chain or not thinking:
        raise DelegateError(f"model routing returned an incomplete result for tier {tier}")
    return chain, thinking, session


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes"}:
        return True
    if normalized in {"0", "false", "no"}:
        return False
    raise DelegateError(f"expected true or false, got {value!r}")


def frozen_route(args: argparse.Namespace) -> dict[str, Any]:
    if args.model:
        reason = (args.reason or "").strip()
        if not reason:
            raise DelegateError("an exact --model lock requires a non-empty --reason")
        if args.chain:
            raise DelegateError("--model and --chain are mutually exclusive")
        return {
            "chain": [args.model],
            "exact": True,
            "policy": args.policy or "exact",
            "policy_digest": args.policy_digest or "-",
            "tier": args.tier or "exact",
            "thinking": args.thinking or "off",
            "session": parse_bool(args.session) if args.session is not None else False,
            "lock_reason": reason,
        }

    tier = args.tier or args.selector
    if not tier:
        raise DelegateError("a frozen --chain with --tier, a tier selector, or an exact --model is required")
    if args.chain:
        chain = [model.strip() for model in args.chain.split(",") if model.strip()]
        if not chain:
            raise DelegateError("frozen --chain must contain at least one model")
        _, default_thinking, default_session = resolve_tier(tier)
    else:
        chain, default_thinking, default_session = resolve_tier(tier)
    return {
        "chain": chain,
        "exact": False,
        "policy": args.policy or f"tier:{tier}",
        "policy_digest": args.policy_digest or "-",
        "tier": tier,
        "thinking": args.thinking or default_thinking,
        "session": parse_bool(args.session) if args.session is not None else default_session,
        "lock_reason": None,
    }



def start_agent_when_ready(argv: list[str]) -> None:
    """Retry only Herdr's transient new-tab shell-readiness rejection."""
    deadline = time.monotonic() + START_READY_TIMEOUT_SECONDS
    while True:
        result = run(argv, check=False)
        if result.returncode == 0:
            return
        detail = (result.stderr or result.stdout or "no diagnostic output").strip()
        if "agent_pane_busy" not in detail or time.monotonic() >= deadline:
            raise DelegateError(
                f"command failed ({result.returncode}): {argv!r}\n{detail}"
            )
        time.sleep(START_RETRY_SECONDS)


def delegation_environment(
    route: dict[str, Any], role: str, label: str, model: str
) -> dict[str, str]:
    """Return frozen identity and failover state inherited by a role worker."""
    return {
        "PI_DELEGATION_KIND": "role",
        "PI_DELEGATION_LABEL": label,
        "PI_DELEGATION_MODEL": model,
        "PI_DELEGATION_POLICY": str(route["policy"]),
        "PI_DELEGATION_POLICY_DIGEST": str(route["policy_digest"]),
        "PI_DELEGATION_ROLE": role,
        "PI_FAILOVER_ROUTE": ",".join(route["chain"]),
        "PI_FAILOVER_TIER": str(route["tier"]),
        "PI_FAILOVER_ROLE": role,
        "PI_FAILOVER_LOCKED": "1" if route["exact"] else "0",
    }


def tab_create_argv(
    workspace: str, cwd: str, label: str, environment: dict[str, str]
) -> list[str]:
    """Build the Herdr tab argv so the worker shell receives its frozen route."""
    argv = [
        "herdr",
        "tab",
        "create",
        "--workspace",
        workspace,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
    ]
    for key, value in environment.items():
        argv.extend(["--env", f"{key}={value}"])
    return argv


def operational_instruction(raw: str | None, cwd: Path | None = None) -> str:
    """The worker runs the exact argv from the directory it starts in. The instruction never names an absolute host
    path: on this host a worker that changes into one writes straight to the host, outside the AgentFS overlay, and
    the ownership audit sees nothing (2026-09-12 operations smoke 2)."""
    if not raw:
        return ""
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DelegateError(f"invalid --command-json: {error}") from error
    if not isinstance(value, dict) or not isinstance(value.get("executable"), str) or not value["executable"] or not isinstance(value.get("args"), list) or not all(isinstance(item, str) for item in value["args"]) or not isinstance(value.get("cwd"), str) or not value["cwd"]:
        raise DelegateError("--command-json requires executable, string args, and cwd")
    if "checkpoint" in value and (not isinstance(value["checkpoint"], str) or not value["checkpoint"]):
        raise DelegateError("--command-json checkpoint must be a path")
    if cwd is not None and Path(value["cwd"]).resolve() != Path(cwd).resolve():
        raise DelegateError("operational command cwd must be the worker working directory")
    argv = [value["executable"], *value["args"]]
    return (
        "\n\nOperational command contract:\n"
        "- Required skill and instruction reads are read-only preparation.\n"
        "- Your first execution command must run this exact argv; do not create a replacement script or run a separate doctor/preflight command first.\n"
        "- cwd: \".\" (the working directory you start in). Never change into an absolute host path: work outside this directory bypasses the sandbox overlay and leaves no audited change.\n"
        f"- argv: {json.dumps(argv, ensure_ascii=False)}\n"
    )


# Strict by default; only an explicit private-launch override discards named paths.
# Mirrored by DEFAULT_IGNORED_PATHS in lib/agentfs-sandbox.ts. The Git index is ignored by default since
# 2026-09-12: a worker that inspects its work with `git status`/`git diff` refreshes the index inside the
# overlay, and the live build measurement refused every such attempt as an unowned change. Ignoring it grants
# no ownership: the index is never exported or staged, and integration refuses Git-internal paths anyway.
DEFAULT_IGNORED_PATHS: tuple[str, ...] = (".git/index",)


def parsed_path_list(raw: str | None, cwd: Path, option: str) -> list[str]:
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DelegateError(f"invalid {option}: {error}") from error
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise DelegateError(f"{option} must be a JSON string array")
    return [str((cwd / item).resolve()) if not Path(item).is_absolute() else str(Path(item).resolve()) for item in value]


def operational_checkpoint_path(raw: str | None, cwd: Path) -> str | None:
    """The checkpoint file declared with the operational command, resolved against the worker's cwd."""
    if not raw:
        return None
    value = json.loads(raw)
    checkpoint = value.get("checkpoint") if isinstance(value, dict) else None
    if not isinstance(checkpoint, str) or not checkpoint:
        return None
    return str(Path(checkpoint).resolve()) if Path(checkpoint).is_absolute() else str((cwd / checkpoint).resolve())


def parsed_owned_paths(raw: str | None, cwd: Path) -> list[str]:
    return parsed_path_list(raw, cwd, "--owned-paths-json")


def parsed_ignored_paths(raw: str | None, cwd: Path) -> list[str]:
    """Absent or empty options ignore nothing; explicit paths never grant ownership."""
    if raw is None:
        raw = json.dumps(list(DEFAULT_IGNORED_PATHS))
    return parsed_path_list(raw, cwd, "--ignored-paths-json")


def worker_pi_settings(real_home: Path, thinking: str | None = None) -> dict[str, Any]:
    """Execution-only Pi settings for a headless worker: supervisor defaults, zero packages, the route's thinking level.

    The supervisor's real settings.json must never reach a worker: its packages list
    loads the pi-agent-wave extension, whose entry point fails closed without Herdr
    identity and kills the worker's ACP server (see prd-headless-pi-stdio-lifecycle US-004).
    """
    settings: dict[str, Any] = {"packages": []}
    source = real_home / ".pi" / "agent" / "settings.json"
    parsed: Any = None
    try:
        parsed = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        parsed = None
    if isinstance(parsed, dict):
        for key in ("defaultProvider", "defaultModel", "defaultThinkingLevel", "compaction", "retry"):
            if key in parsed:
                settings[key] = parsed[key]
    # The frozen route decides how hard a role thinks; the supervisor's own default is only the fallback.
    if isinstance(thinking, str) and thinking.strip():
        settings["defaultThinkingLevel"] = thinking.strip()
    return settings


def provider_from_model(model: str) -> str:
    """Provider prefix of a frozen `provider/model` identifier."""
    return str(model or "").split("/", 1)[0]


def provider_preflight_environment(real_home: Path) -> dict[str, str]:
    """Environment for credential preflight: the real home and its agent dir, never the caller's exports."""
    return {**os.environ, "HOME": str(real_home), "PI_CODING_AGENT_DIR": str(real_home / ".pi" / "agent")}


def agent_for_model(model: str) -> str:
    """Mirror of selectAcpAgent() in lib/acpx-select.ts; a parity test keeps the two in step."""
    if str(model).startswith("openai-codex/"):
        return "codex"
    if str(model).startswith("claude-code/"):
        return "claude"
    return "pi"


def preflight_agent_credentials(agent: str, provider: str, model: str, real_home: Path, command_runner: Any = run) -> str:
    """Check the credential store the executing agent actually reads; structural and offline by design.

    A live probe would cost a model call per dispatch (a one-line `codex exec` consumed ~17k tokens), so
    revoked-but-unexpired tokens are left to the runtime guards: they surface as a transient
    worker-runtime failure and the frozen chain advances.
    """
    if agent == "codex":
        codex_home = Path(os.environ.get("CODEX_HOME") or (real_home / ".codex"))
        auth = codex_home / "auth.json"
        remedy = "codex logout && codex login"
        if not auth.is_file():
            raise DelegateError(f'worker preflight: codex agent has no credential for {model} (missing {auth}); run: {remedy}')
        try:
            payload = json.loads(auth.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DelegateError(f'worker preflight: codex agent credential is unreadable for {model} ({auth}: {error}); run: {remedy}') from error
        if not isinstance(payload, dict):
            raise DelegateError(f'worker preflight: codex agent credential is not an object for {model} ({auth}); run: {remedy}')
        if payload.get("OPENAI_API_KEY"):
            return "api_key"
        tokens = payload.get("tokens")
        if isinstance(tokens, dict) and tokens.get("access_token"):
            return str(payload.get("auth_mode") or "chatgpt")
        raise DelegateError(f'worker preflight: codex agent credential for {model} has neither OPENAI_API_KEY nor tokens.access_token ({auth}); run: {remedy}')
    if agent == "claude":
        token_file = os.environ.get("PI_CLAUDE_OAUTH_TOKEN_FILE")
        if token_file:
            source = Path(token_file)
            if source.is_file() and not source.stat().st_mode & 0o077:
                return "token-file"
            raise DelegateError(f'worker preflight: claude agent credential for {model} is not a mode-600 regular file ({source}); run: claude setup-token')
        credentials = real_home / ".claude" / ".credentials.json"
        if credentials.is_file():
            return "credentials-file"
        raise DelegateError(
            f'worker preflight: claude agent has no credential for {model}; set PI_CLAUDE_OAUTH_TOKEN_FILE to a mode-600 token file or sign in so {credentials} exists'
        )
    auth_type, _reason = preflight_provider_credential(provider, model, real_home, command_runner=command_runner)
    return auth_type


def preflight_provider_credential(provider: str, model: str, real_home: Path, command_runner: Any = run) -> tuple[str, str | None]:
    """Ask Pi whether the provider reports ready. Non-blocking: a usable credential overrides the answer."""
    argv = ["pi", "auth", "check", "--provider", provider, "--json", "--no-refresh"]
    try:
        result = command_runner(argv, check=False, env=provider_preflight_environment(real_home))
    except Exception as error:
        return "unknown", f"check-unavailable: {error}"
    try:
        payload = json.loads(str(result.stdout or ""))
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    status = payload.get("status")
    if result.returncode == 0 and status == "ready":
        return str(payload.get("authType") or "unknown"), None
    reason = str(payload.get("reason") or f"status={status if status is not None else 'unparseable'} exit={result.returncode}")
    return str(payload.get("authType") or "unknown"), reason


def materialize_pi_credentials(pi_agent_dir: Path, real_home: Path, provider: str, model: str, command_runner: Any = run) -> dict[str, str]:
    """Write an attempt-private mode-600 auth.json for one provider; never link or rewrite the live store."""
    auth_type, check_reason = preflight_provider_credential(provider, model, real_home, command_runner=command_runner)
    live = real_home / ".pi" / "agent" / "auth.json"
    entry: Any = None
    if live.exists():
        try:
            stored = json.loads(live.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DelegateError(f'worker preflight: provider "{provider}" has no usable credential for {model} (live-auth-unreadable: {error})') from error
        if isinstance(stored, dict) and isinstance(stored.get(provider), dict):
            entry = stored[provider]
    if entry is None:
        resolved = command_runner(["pi", "auth", "print-api-key", "--provider", provider], check=False, env=provider_preflight_environment(real_home))
        value = str(resolved.stdout or "").strip()
        if resolved.returncode != 0 or not value:
            detail = f"check={check_reason or 'not-ready'}" if check_reason else f"check=ready({auth_type})"
            raise DelegateError(f'worker preflight: provider "{provider}" has no usable credential for {model} ({detail}; print-api-key exit={resolved.returncode} {(resolved.stderr or "").strip()[:120]})')
        entry = {"type": "api_key", "key": value}
    destination = pi_agent_dir / "auth.json"
    return materialize_credential_file(destination, json.dumps({provider: entry}, indent=2, sort_keys=True) + "\n")


def materialize_credential_file(destination: Path, content: str) -> dict[str, str]:
    """Write one agent credential as a private regular file and record the invariant that must survive a refresh."""
    data = content.encode("utf-8")
    write_private_bytes(destination, data)
    try:
        parsed = json.loads(data.decode("utf-8"))
        key_set = json.dumps(sorted(parsed.keys())) if isinstance(parsed, dict) else "unparseable"
    except (UnicodeDecodeError, json.JSONDecodeError):
        key_set = "unparseable"
    return {
        "kind": "file",
        "link": str(destination),
        "keySet": key_set,
        "sha256": hashlib.sha256(data).hexdigest(),
        "mode": oct(destination.stat().st_mode & 0o777),
    }


def copy_credential_file(source: Path, destination: Path) -> dict[str, str]:
    """Copy a live agent credential into the attempt so a refresh cannot write through to the live store."""
    return materialize_credential_file(destination, source.read_text(encoding="utf-8"))


def copy_runtime_file(source: Path, destination: Path, *, mutable_catalog: bool = False, tolerate_self_writes: bool = False) -> dict[str, str]:
    """Copy private runtime data; only a provider catalog may refresh its contents.

    A snapshot marked ``selfWrites: tolerated`` (Claude's own JSON configuration, 2026-09-12 decision) may be
    rewritten by the agent inside the attempt: it must stay a private regular JSON object, and every change is
    recorded rather than refused. All other snapshots keep exact bytes.
    """
    data = source.read_bytes()
    write_private_bytes(destination, data)
    record: dict[str, str] = {
        "kind": "catalog-cache" if mutable_catalog else "snapshot",
        "link": str(destination),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mode": oct(destination.stat().st_mode & 0o777),
    }
    if tolerate_self_writes:
        try:
            parsed = json.loads(data.decode("utf-8"))
            key_set = json.dumps(sorted(parsed.keys())) if isinstance(parsed, dict) else "unparseable"
        except (UnicodeDecodeError, json.JSONDecodeError):
            key_set = "unparseable"
        record["selfWrites"] = "tolerated"
        record["keySet"] = key_set
    return record


def provider_runtime_environment(attempt_dir: Path, acpx_home: Path, real_home: Path, selected_model: str = "", command_runner: Any = run, thinking: str | None = None) -> tuple[dict[str, str], list[dict[str, str]]]:
    """Build private credentials, frozen configuration and a refreshable provider catalog."""
    if not selected_model:
        raise DelegateError("provider runtime environment requires the frozen selected model")
    providers = attempt_dir / "providers"
    pi_agent_dir = providers / "pi-agent"
    codex_home = providers / "codex"
    claude_home = providers / "claude"
    pi_agent_dir.mkdir(parents=True, mode=0o700)
    codex_home.mkdir(parents=True, mode=0o700)
    claude_home.mkdir(parents=True, mode=0o700)
    agent = agent_for_model(selected_model)
    provider = provider_from_model(selected_model)
    preflight_agent_credentials(agent, provider, selected_model, real_home, command_runner=command_runner)
    links: list[dict[str, str]] = []
    if agent == "pi":
        links.append(materialize_pi_credentials(pi_agent_dir, real_home, provider, selected_model, command_runner=command_runner))
    elif agent == "codex":
        codex_auth = Path(os.environ.get("CODEX_HOME") or (real_home / ".codex")) / "auth.json"
        links.append(copy_credential_file(codex_auth, codex_home / "auth.json"))
    else:
        claude_credentials = real_home / ".claude" / ".credentials.json"
        if claude_credentials.is_file():
            links.append(copy_credential_file(claude_credentials, claude_home / ".credentials.json"))
    configuration = {
        "pi": (
            (real_home / ".pi" / "agent" / "models.json", pi_agent_dir / "models.json"),
            (real_home / ".pi" / "agent" / "models-store.json", pi_agent_dir / "models-store.json"),
            (real_home / ".pi" / "agent" / "model-routing.jsonc", pi_agent_dir / "model-routing.jsonc"),
        ),
        "codex": ((Path(os.environ.get("CODEX_HOME", str(real_home / ".codex"))).expanduser() / "config.toml", codex_home / "config.toml"),),
        "claude": (
            (real_home / ".claude.json", acpx_home / ".claude.json"),
            (real_home / ".claude" / "settings.json", claude_home / "settings.json"),
        ),
    }
    for source, destination in configuration[agent]:
        if source.exists():
            links.append(copy_runtime_file(source, destination, mutable_catalog=agent == "pi" and destination.name == "models-store.json", tolerate_self_writes=agent == "claude"))
    claude_token_source = os.environ.get("PI_CLAUDE_OAUTH_TOKEN_FILE") if agent == "claude" else None
    claude_token_link: Path | None = None
    if claude_token_source:
        source = Path(claude_token_source).resolve()
        if not source.is_file() or source.stat().st_mode & 0o077:
            raise DelegateError("PI_CLAUDE_OAUTH_TOKEN_FILE must name a mode-600 regular file")
        claude_token_link = claude_home / "setup-token"
        links.append(copy_runtime_file(source, claude_token_link))
    write_private(pi_agent_dir / "settings.json", json.dumps(worker_pi_settings(real_home, thinking), indent=2, sort_keys=True) + "\n")
    environment = {
        "PI_CODING_AGENT_DIR": str(pi_agent_dir),
        "CODEX_HOME": str(codex_home),
        "CLAUDE_CONFIG_DIR": str(claude_home),
    }
    if claude_token_link:
        environment["PI_CLAUDE_OAUTH_TOKEN_FILE"] = str(claude_token_link)
    return environment, links


def prepare_acpx_attempt(
    run_dir: Path,
    args: argparse.Namespace,
    state: dict[str, Any],
    agent_name: str,
    model: str,
    task_file: Path,
    node: str,
    thinking: str | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    result_contract = "runtime-v1"
    cwd = Path.cwd().resolve()
    real_home = Path(os.environ.get("HOME", str(Path.home()))).resolve()
    workspace_relative = "."
    run_id = args.run_id or state["run_label"]
    operation_id = args.operation_id or agent_name
    model_attempt = args.model_attempt
    transient_attempt = args.transient_attempt
    plan_result = run([
        NODE, "--experimental-strip-types", str(ACPX_PLAN),
        run_id, operation_id, args.role, str(model_attempt), str(transient_attempt),
        model, agent_name, "pending-tab", "pending-pane", ACTIVE_TRANSPORT,
    ]).stdout
    try:
        plan = json.loads(plan_result)
        agent = str(plan["agent"])
        session_name = str(plan["sessionName"])
    except (json.JSONDecodeError, KeyError) as error:
        raise DelegateError(f"invalid ACPX plan output: {error}") from error
    attempt_dir = run_dir / "acpx" / agent_name
    attempt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    acpx_home = attempt_dir / "acpx-home"
    agentfs_home = attempt_dir / "agentfs-home"
    acpx_home.mkdir(mode=0o700)
    agentfs_home.mkdir(mode=0o700)
    provider_environment, provider_links = provider_runtime_environment(attempt_dir, acpx_home, real_home, model, thinking=thinking)
    prompt_file = attempt_dir / "prompt.md"
    read_only = args.access_mode == "read-only" if args.access_mode is not None else node not in {"implement", "source_search"}
    # The answer is the assistant's public text and the audited overlay changes; no report file exists to author or repair.
    prompt = task_file.read_text(encoding="utf-8") + operational_instruction(args.command_json, cwd) + "\n"
    prompt += "Reply with your complete result as ordinary assistant text. No report file is required or read.\n"
    verdicts = RUNTIME_VERDICT_NODES.get(node)
    if verdicts:
        prompt += "End your reply with one final line of the exact form VERDICT: <value>, where <value> is one of " + ", ".join(verdicts) + ". State the verdict exactly once and only after the evidence that supports it.\n"
    if args.no_terminal:
        prompt += "Terminal capability is disabled. Use ACP filesystem read/search capabilities only; consume recorded host evidence instead of running commands.\n"
    if read_only:
        prompt += "Read-only host mode: all tool activity stays inside AgentFS COW and every overlay change will be discarded. Zero repository paths are exported.\n"
    write_private(prompt_file, prompt)
    config_path = attempt_dir / "worker-config.json"
    result_path = attempt_dir / "worker-result.json"
    stdout_path = attempt_dir / "worker.stdout.ndjson"
    stderr_path = attempt_dir / "worker.stderr.txt"
    acpx_executable = shutil.which("acpx") or "acpx"
    agentfs_executable = shutil.which("agentfs") or "agentfs"
    node_executable = shutil.which("node") or NODE
    config = {
        "schemaVersion": 1,
        "acpxExecutable": acpx_executable,
        "agent": agent,
        "selectedModel": model,
        "sessionName": session_name,
        "workspaceRelative": workspace_relative,
        "node": node,
        "claudeTokenFile": provider_environment.get("PI_CLAUDE_OAUTH_TOKEN_FILE"),
        "acpxHome": str(acpx_home),
        "mode": "prompt",
        "promptFile": str(prompt_file),
        "resultPath": str(result_path),
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "timeoutSeconds": 3600,
        "hostReadOnly": read_only,
        "discardAllChanges": read_only,
        "noTerminal": args.no_terminal,
    }
    config["resultContract"] = result_contract
    config["attemptKey"] = plan["attemptKey"]
    write_private(config_path, json.dumps(config, indent=2, sort_keys=True) + "\n")
    launcher = attempt_dir / "launch-acpx.sh"
    launcher_text = "#!/bin/sh\nexec " + " ".join([
        shlex.quote(agentfs_executable), "run", "--session", shlex.quote(session_name),
        "--no-default-allows", "--allow", shlex.quote(str(run_dir)),
        shlex.quote(node_executable), "--experimental-strip-types", shlex.quote(str(ACPX_WORKER)),
    ]) + "\n"
    write_private(launcher, launcher_text)
    launcher.chmod(0o700)
    cancel_config = attempt_dir / "cancel-config.json"
    write_private(cancel_config, json.dumps({ "schemaVersion": 1, "acpxExecutable": acpx_executable, "agent": agent, "sessionName": session_name, "recordId": session_name, "attemptKey": plan["attemptKey"], "cwd": str(agentfs_home / ".agentfs" / "run" / session_name / "mnt"), "acpxHome": str(acpx_home), "timeoutSeconds": 30 }, indent=2, sort_keys=True) + "\n")
    cancel_launcher = attempt_dir / "cancel-acpx.sh"
    cancel_text = "#!/bin/sh\nPI_ACPX_CANCEL_CONFIG=" + shlex.quote(str(cancel_config)) + " exec " + " ".join([shlex.quote(node_executable), "--experimental-strip-types", shlex.quote(str(ACPX_CANCEL))]) + "\n"
    write_private(cancel_launcher, cancel_text)
    cancel_launcher.chmod(0o700)
    owned_paths = parsed_owned_paths(args.owned_paths_json, cwd)
    ignored_paths = parsed_ignored_paths(getattr(args, "ignored_paths_json", None), cwd)
    path_parts = [str(Path(node_executable).parent), str(Path(acpx_executable).parent), str(Path(agentfs_executable).parent), os.environ.get("PATH", "")]
    environment = {
        "PI_ACPX_CONFIG": str(config_path),
        "HOME": str(agentfs_home),
        "PATH": os.pathsep.join(path_parts),
        **provider_environment,
    }
    agentfs_db_path = agentfs_home / ".agentfs" / "run" / session_name / "delta.db"
    base_revision = run(["git", "-C", str(cwd), "rev-parse", "HEAD"], check=False).stdout.strip()
    resource = {
        "execution": "acpx-agentfs",
        "result_contract": result_contract,
        "base_dir": str(cwd),
        "base_revision": base_revision or None,
        "checkpoint_path": operational_checkpoint_path(args.command_json, cwd),
        "owned_paths": owned_paths,
        "ignored_paths": ignored_paths,
        "read_only": read_only,
        "run_id": run_id,
        "operation_id": operation_id,
        "acp_agent": agent,
        "acpx_session": session_name,
        "acpx_record_id": session_name,
        "acpx_attempt_key": plan["attemptKey"],
        "attempt_identity": plan,
        "agentfs_session": session_name,
        "agentfs_home": str(agentfs_home),
        "acpx_home": str(acpx_home),
        "agentfs_db_path": str(agentfs_db_path),
        "attempt_dir": str(attempt_dir),
        "worker_config": str(config_path),
        "worker_result": str(result_path),
        "worker_launcher": str(launcher),
        "worker_environment": environment.copy(),
        "acpx_cancel_script": str(cancel_launcher),
        "acpx_cancel_config": str(cancel_config),
        "prompt_file": str(prompt_file),
        "owned_paths": owned_paths,
        "sandbox_base": str(cwd),
        "workspace_relative": workspace_relative,
        "provider_links": provider_links,
        "transient_attempt": transient_attempt,
    }
    return resource, environment


def launch_headless_worker(resource: dict[str, Any], environment: dict[str, str]) -> int:
    process = subprocess.Popen([
        sys.executable, str(HEADLESS_SUPERVISOR),
        "--launcher", str(resource["worker_launcher"]),
        "--cwd", str(resource["sandbox_base"]),
        "--stdout", str(resource["headless_stdout"]),
        "--stderr", str(resource["headless_stderr"]),
        "--status", str(resource["headless_status"]),
    ], cwd=Path(str(resource["sandbox_base"])), env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return process.pid


def command_start(args: argparse.Namespace) -> None:
    if using_herdr():
        require_herdr()
        ensure_pi_integration()
    else:
        require_worker_runtime()
    run_dir = require_run_dir(args.run_dir)
    route = frozen_route(args)

    task_value = args.task_file_option or args.task_file
    # An exact lock may omit the tier selector, in which case the single positional path is the task file.
    if args.model and not task_value and args.selector:
        task_value = args.selector
    if not task_value:
        raise DelegateError("start requires a task file")
    task_file = Path(task_value)
    if not task_file.is_file():
        raise DelegateError(f"delegate task file does not exist: {task_file}")
    task_mode = task_file.stat().st_mode & 0o777
    if task_mode != 0o600:
        raise DelegateError(
            f"delegate task file mode is {task_mode:o}, expected 600: {task_file}"
        )

    node = args.node or ROLE_NODES.get(args.role.lower())
    if not node:
        raise DelegateError(f"start requires --node for role {args.role!r}")
    role_slug = slugify(args.role)
    state = read_state(run_dir)
    run_slug = str(state["run_slug"])
    ordinal = 1 + sum(1 for resource in state["resources"] if resource["role"] == args.role)
    role_label = args.role if ordinal == 1 else f"{args.role}-{ordinal}"
    agent_name = f"dg_{run_slug[:8]}_{role_slug[:9]}_{secrets.token_hex(4)}"
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", agent_name):
        raise DelegateError(f"generated invalid Herdr agent name: {agent_name}")

    chain = route["chain"]
    selected_model = chain[0]
    first_label = (
        f"{state['run_label']}: {role_label} [{route['policy']}] "
        f"@ {selected_model.rsplit('/', 1)[-1]}"
    )
    acpx_resource, runtime_environment = prepare_acpx_attempt(
        run_dir, args, state, agent_name, selected_model, task_file, node, thinking=route["thinking"]
    )
    environment = delegation_environment(route, args.role, first_label, selected_model)
    environment.update(runtime_environment)
    if using_herdr():
        tab_result = run(
            tab_create_argv(
                os.environ["HERDR_WORKSPACE_ID"], str(acpx_resource["sandbox_base"]), first_label, environment
            )
        ).stdout
        tab_id = str(json_path(tab_result, "result", "tab", "tab_id"))
        pane_id = str(json_path(tab_result, "result", "root_pane", "pane_id"))
        final_plan_result = run([
            NODE, "--experimental-strip-types", str(ACPX_PLAN),
            str(acpx_resource["run_id"]), str(acpx_resource["operation_id"]), args.role,
            str(args.model_attempt), str(args.transient_attempt), selected_model, agent_name, tab_id, pane_id, "herdr",
        ]).stdout
        try:
            final_plan = json.loads(final_plan_result)
        except json.JSONDecodeError as error:
            raise DelegateError(f"invalid final ACPX identity: {error}") from error
        if final_plan.get("sessionName") != acpx_resource["acpx_session"] or final_plan.get("agent") != acpx_resource["acp_agent"]:
            raise DelegateError("final ACPX identity changed after Herdr binding")
    else:
        tab_id = None
        pane_id = None
        final_plan = acpx_resource["attempt_identity"]

    resource = {
        "run_dir": str(run_dir),
        "agent": agent_name,
        "transport": ACTIVE_TRANSPORT,
        "pane": pane_id,
        "worker_pid": None,
        "headless_stdout": str(run_dir / f"headless-{slugify(agent_name)}.stdout"),
        "headless_stderr": str(run_dir / f"headless-{slugify(agent_name)}.stderr"),
        "headless_status": str(run_dir / f"headless-{slugify(agent_name)}.status.json"),
        "role": args.role,
        "node": node,
        "role_label": role_label,
        "tab": tab_id,
        "policy": route["policy"],
        "policy_digest": route["policy_digest"],
        "tier": route["tier"],
        "model": selected_model,
        "model_attempt": args.model_attempt,
        "chain": chain,
        "chain_length": len(chain),
        "fallback_reason": args.fallback_reason,
        "model_lock_reason": route["lock_reason"],
        **acpx_resource,
        "attempt_identity": final_plan,
    }
    mutate_state(run_dir, lambda current: current["resources"].append(resource))

    try:
        if using_herdr():
            run([
                "herdr", "pane", "report-agent", str(pane_id),
                "--source", "pi-agent-wave-acpx", "--agent", agent_name,
                "--state", "working", "--message", f"ACPX {resource['acp_agent']} session {resource['acpx_session']}",
                "--seq", "1", "--agent-session-id", resource["acpx_session"],
                "--agent-session-path", resource["worker_config"],
            ])
            run(["herdr", "pane", "run", str(pane_id), resource["worker_launcher"]])
        else:
            worker_pid = launch_headless_worker(resource, environment)
            resource["worker_pid"] = worker_pid
            def record_pid(current: dict[str, Any]) -> None:
                for owned in current["resources"]:
                    if owned.get("agent") == agent_name:
                        owned["worker_pid"] = worker_pid
                        return
                raise DelegateError(f"unknown headless worker {agent_name}")
            mutate_state(run_dir, record_pid)
    except Exception:
        if using_herdr():
            try:
                close_created_tab(run_dir, str(tab_id))
            except Exception as cleanup_error:
                print(f"failed to clean up tab {tab_id}: {cleanup_error}", file=sys.stderr)
        raise

    print(
        json.dumps(
            {
                "agent": agent_name,
                "transport": ACTIVE_TRANSPORT,
                "policy": route["policy"],
                "policy-digest": route["policy_digest"],
                "tier": route["tier"],
                "model": selected_model,
                "model-attempt": args.model_attempt,
                "chain-length": len(chain),
                "fallback-reason": args.fallback_reason,
                "model-lock-reason": route["lock_reason"],
                "acp-agent": resource["acp_agent"],
                "acpx-session": resource["acpx_session"],
                "acpx-attempt-key": resource["acpx_attempt_key"],
                "acpx-cancel-script": resource["acpx_cancel_script"],
                "agentfs-session": resource["agentfs_session"],
                "agentfs-db": resource["agentfs_db_path"],
                "attempt-identity": resource["attempt_identity"],
                "pane": pane_id,
                "tab": tab_id,
            },
            sort_keys=True,
        )
    )


def owned_resource(run_dir: Path, agent_name: str) -> dict[str, Any]:
    resources = [
        resource
        for resource in read_state(run_dir)["resources"]
        if resource["agent"] == agent_name
    ]
    if not resources:
        raise DelegateError(f"agent is not owned by this run: {agent_name}")
    return resources[-1]


def close_settled_tab(
    run_dir: Path,
    resource: dict[str, Any],
    primary_error: DelegateError | None = None,
) -> None:
    if not using_herdr():
        if primary_error is not None:
            raise primary_error
        return
    try:
        close_created_tab(run_dir, resource["tab"])
    except DelegateError as close_error:
        if primary_error is not None:
            raise DelegateError(
                f"{primary_error}\nfailed to close settled worker tab: {close_error}"
            ) from close_error
        raise
    if primary_error is not None:
        raise primary_error


ACPX_PERMISSION_DENIED_EXIT = 5  # acpx EXIT_CODES.PERMISSION_DENIED
APPROVAL_BLOCK_TEXT = re.compile(
    r"permission[_ \-]?denied|permission (?:request )?(?:denied|cancelled)"
    r"|permission denied for (?:terminal|fs|tool)"
    r"|denied (?:by|before) [^,.;\n]*(?:approval|permission)",
    re.IGNORECASE,
)


def is_approval_block(result: dict[str, Any]) -> bool:
    """True when the worker result reports a denied authorization rather than a runtime fault."""
    if result.get("permissionDenied") is True:
        return True
    if str(result.get("status", "")).lower() in ("permission_denied", "access_denied"):
        return True
    return result.get("processExitCode") == ACPX_PERMISSION_DENIED_EXIT


WORKER_EXIT_TIMEOUT_MS = os.environ.get("PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS", "30000")


def wait_for_worker_exit(resource: dict[str, Any], timeout_ms: int | None = None) -> dict[str, Any]:
    """Waits, bounded, for the headless worker process to exit after its result file appears.

    worker-result.json is written before the AgentFS server and acpx child have finished tearing
    down, so auditing on file presence alone can read a delta that is still being flushed.
    """
    worker_pid = resource.get("worker_pid")
    started = time.monotonic()
    if using_herdr() or not isinstance(worker_pid, int):
        observation = {"pid": worker_pid if isinstance(worker_pid, int) else None, "exited": None, "waitedMs": 0}
        resource["worker_exit"] = observation
        return observation
    budget = (int(WORKER_EXIT_TIMEOUT_MS) if timeout_ms is None else timeout_ms) / 1000
    deadline = started + budget

    def exited_now() -> bool:
        # `start` and `wait` normally run as separate processes, so the worker is not our child; when
        # it is (same-process callers, tests), reap it so a zombie is not mistaken for a live worker.
        try:
            reaped, _ = os.waitpid(worker_pid, os.WNOHANG)
            if reaped == worker_pid:
                return True
        except ChildProcessError:
            pass
        return not process_alive(worker_pid)

    exited = exited_now()
    while not exited and time.monotonic() < deadline:
        time.sleep(0.05)
        exited = exited_now()
    observation = {"pid": worker_pid, "exited": exited, "waitedMs": int((time.monotonic() - started) * 1000)}
    resource["worker_exit"] = observation
    if not exited:
        raise DelegateError(f"ACPX worker result present but worker process {worker_pid} did not exit within {int(budget * 1000)}ms")
    return observation


def wait_for_settled_agent(run_dir: Path, resource: dict[str, Any]) -> None:
    agent_name = str(resource["agent"])
    if resource.get("execution") == "acpx-agentfs":
        result_path = Path(str(resource["worker_result"]))
        deadline = time.monotonic() + (int(WAIT_TIMEOUT_MS) / 1000)
        while time.monotonic() < deadline and not result_path.exists():
            worker_pid = resource.get("worker_pid")
            if not using_herdr() and isinstance(worker_pid, int) and not process_alive(worker_pid):
                diagnostic_paths = [Path(str(resource.get("headless_stdout", ""))), Path(str(resource.get("headless_stderr", "")))]
                diagnostic = "\n".join(path.read_text(encoding="utf-8").strip() for path in diagnostic_paths if path.exists()).strip() or "no diagnostic output"
                raise DelegateError(f"headless worker exited before result: {diagnostic[-2000:]}")
            time.sleep(0.1)
        if not result_path.exists():
            raise DelegateError(f"ACPX worker result timed out: {result_path}")
        wait_for_worker_exit(resource)
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DelegateError(f"invalid ACPX worker result: {error}") from error
        resource["worker_observation"] = result
        if result.get("schemaVersion") == 2 and result.get("resultContract") == "runtime-v1":
            # The runtime worker records its process outcome durably; settlement reads it and no
            # terminal event, exit code or report is interpreted here.
            return
        exit_code = result.get("processExitCode")
        terminal = result.get("terminal")
        terminal_kind = terminal.get("kind") if isinstance(terminal, dict) else None
        state = "idle" if exit_code == 0 and terminal_kind == "completed" else "blocked"
        if using_herdr():
            run([
                "herdr", "pane", "report-agent", str(resource["pane"]),
                "--source", "pi-agent-wave-acpx", "--agent", agent_name,
                "--state", state, "--message", f"ACPX terminal {terminal_kind or 'missing'}",
                "--seq", "2",
            ])
        if exit_code != 0 or terminal_kind != "completed":
            if is_approval_block(result):
                raise DelegateError(
                    f"worker approval block: permission_denied exit={exit_code} terminal={terminal_kind}; "
                    "the authorized command was denied before execution, so a retry replays the same denial"
                )
            raise DelegateError(f"ACPX worker failed: exit={exit_code} terminal={terminal_kind}")
        return
    wait_result = run(
        ["herdr", "agent", "wait", agent_name, "--timeout", WAIT_TIMEOUT_MS],
        check=False,
    )
    if wait_result.returncode != 0:
        diagnostic = run(["herdr", "agent", "get", agent_name], check=False)
        detail = (diagnostic.stdout or diagnostic.stderr).strip()
        error = DelegateError(f"Herdr agent wait failed: {agent_name}\n{detail}")
        try:
            status = str(json_path(diagnostic.stdout, "result", "agent", "agent_status"))
        except DelegateError:
            status = "unknown"
        if status == "blocked":
            return
        close_settled_tab(run_dir, resource, error)

    agent_result = run(["herdr", "agent", "get", agent_name]).stdout
    status = str(json_path(agent_result, "result", "agent", "agent_status"))
    if status not in {"idle", "done", "blocked"}:
        close_settled_tab(run_dir, resource, DelegateError(f"Herdr agent settled in unsupported state {status!r}: {agent_name}"))





def run_acpx_again(resource: dict[str, Any], prompt: str | None, mode: str, suffix: str) -> dict[str, Any]:
    config_path = Path(str(resource["worker_config"]))
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if prompt is not None:
        write_private(Path(str(resource["prompt_file"])), prompt + "\n")
    attempt_dir = Path(str(resource["attempt_dir"]))
    result_path = attempt_dir / f"worker-{suffix}-result.json"
    config.update({
        "mode": mode,
        "resultPath": str(result_path),
        "stdoutPath": str(attempt_dir / f"worker-{suffix}.stdout.ndjson"),
        "stderrPath": str(attempt_dir / f"worker-{suffix}.stderr.txt"),
    })
    write_private(config_path, json.dumps(config, indent=2, sort_keys=True) + "\n")
    result_path.unlink(missing_ok=True)
    resource["worker_result"] = str(result_path)
    if using_herdr():
        run([
            "herdr", "pane", "report-agent", str(resource["pane"]),
            "--source", "pi-agent-wave-acpx", "--agent", str(resource["agent"]),
            "--state", "working", "--message", f"ACPX {mode} {resource['acpx_session']}",
            "--seq", "2",
        ])
        run(["herdr", "pane", "run", str(resource["pane"]), str(resource["worker_launcher"])])
    else:
        repeat_environment = { **os.environ, **resource.get("worker_environment", {}), "PI_ACPX_CONFIG": str(config_path) }
        run([str(resource["worker_launcher"])], env=repeat_environment)
    deadline = time.monotonic() + (int(WAIT_TIMEOUT_MS) / 1000)
    while time.monotonic() < deadline and not result_path.exists():
        time.sleep(0.1)
    if not result_path.exists():
        raise DelegateError(f"ACPX {mode} result timed out: {result_path}")
    try:
        return json.loads(result_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DelegateError(f"invalid ACPX {mode} result: {error}") from error


def snapshot_agentfs_db(resource: dict[str, Any], timeout_ms: int = 30000) -> Path:
    """Create one consistent SQLite backup or refuse export; never copy live sidecars."""
    source = Path(str(resource["agentfs_db_path"]))
    snapshot_dir = Path(str(resource["attempt_dir"])) / "agentfs-snapshot"
    snapshot_dir.mkdir(mode=0o700, exist_ok=True)
    snapshot_dir.chmod(0o700)
    snapshot = snapshot_dir / "delta.db"
    for suffix in ("", "-wal", "-shm"):
        Path(str(snapshot) + suffix).unlink(missing_ok=True)
    deadline = time.monotonic() + timeout_ms / 1000

    def progress(status: int, remaining: int, total: int) -> None:
        if time.monotonic() >= deadline:
            raise sqlite3.OperationalError(f"backup timed out after {timeout_ms}ms")

    try:
        write_private_bytes(snapshot, b"")
        source_connection = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=timeout_ms / 1000)
        try:
            target_connection = sqlite3.connect(snapshot, timeout=timeout_ms / 1000)
            try:
                source_connection.backup(target_connection, pages=256, progress=progress, sleep=0.05)
                # The source WAL header is inherited; DELETE keeps the snapshot self-contained.
                target_connection.execute("PRAGMA journal_mode=DELETE")
            finally:
                target_connection.close()
        finally:
            source_connection.close()
        snapshot.chmod(0o600)
    except (sqlite3.Error, OSError) as error:
        resource["agentfs_snapshot"] = {"path": str(snapshot), "method": "failed", "backupError": str(error)}
        for suffix in ("", "-wal", "-shm"):
            Path(str(snapshot) + suffix).unlink(missing_ok=True)
        raise DelegateError(f"AgentFS snapshot failed: {error}") from error
    resource["agentfs_snapshot"] = {"path": str(snapshot), "method": "backup", "backupError": None}
    # The runtime settle configuration receives the snapshot path directly; the legacy export configuration it used to rewrite is gone.
    return snapshot



def verify_provider_links(resource: dict[str, Any]) -> bool:
    for item in resource.get("provider_links", []):
        link = Path(str(item["link"]))
        if item.get("kind", "symlink") in ("file", "snapshot", "catalog-cache"):
            label = {"snapshot": "runtime configuration snapshot", "file": "materialized provider credential", "catalog-cache": "runtime catalog cache"}[item["kind"]]
            if link.is_symlink():
                raise DelegateError(f"{label} became a symlink: {link}")
            if not link.is_file():
                raise DelegateError(f"{label} is missing: {link}")
            if oct(stat.S_IMODE(link.stat().st_mode)) != item["mode"]:
                raise DelegateError(f"{label} mode changed: {link}")
            if item["kind"] == "catalog-cache":
                continue
            if item["kind"] == "snapshot":
                data = link.read_bytes()
                observed_sha = hashlib.sha256(data).hexdigest()
                if item.get("selfWrites") != "tolerated":
                    if observed_sha != item["sha256"]:
                        raise DelegateError(f"{label} changed: {link}")
                    continue
                # Tolerated self-write (Claude rewrites its own settings.json / .claude.json during tool use):
                # the file must still be a JSON object; what changed is recorded, never refused.
                try:
                    observed = json.loads(data.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise DelegateError(f"{label} changed and is no longer a JSON object: {link} ({type(error).__name__})") from error
                if not isinstance(observed, dict):
                    raise DelegateError(f"{label} changed and is no longer a JSON object: {link}")
                if observed_sha != item["sha256"]:
                    recorded_keys = set(json.loads(item["keySet"])) if item.get("keySet") not in (None, "unparseable") else set()
                    observed_keys = set(observed.keys())
                    self_writes = resource.setdefault("configuration_self_writes", {})
                    self_writes[link.name] = {
                        "name": link.name,
                        "addedKeys": sorted(observed_keys - recorded_keys),
                        "removedKeys": sorted(recorded_keys - observed_keys),
                        "contentChanged": True,
                        "expectedSha256": item["sha256"],
                        "observedSha256": observed_sha,
                    }
                continue
            # The byte hash is deliberately not compared for a JSON credential store: an agent refreshes
            # its own tokens by rewriting this private file inside the attempt, which is confined and
            # expected. What must not change is the store's shape. A non-JSON store keeps hash equality.
            recorded = str(item.get("keySet", "unparseable"))
            if recorded == "unparseable":
                if hashlib.sha256(link.read_bytes()).hexdigest() != item["sha256"]:
                    raise DelegateError(f"materialized provider credential changed: {link}")
                continue
            try:
                observed = json.loads(link.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise DelegateError(f"materialized provider credential is unreadable: {link} ({error})") from error
            observed_keys = json.dumps(sorted(observed.keys())) if isinstance(observed, dict) else "unparseable"
            if observed_keys != recorded:
                raise DelegateError(f"materialized provider credential key set changed: {link}")
            continue
        target = Path(str(item["target"]))
        if not link.is_symlink() or link.resolve() != target.resolve():
            raise DelegateError(f"provider credential link changed: {link}")
        if hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
            raise DelegateError(f"provider credential target changed: {target}")
        if oct(target.stat().st_mode & 0o777) != item["mode"]:
            raise DelegateError(f"provider credential mode changed: {target}")
    return True


def observe_presentation_identity(resource: dict[str, Any]) -> dict[str, Any]:
    identity = resource.get("attempt_identity")
    presentation = identity.get("presentation") if isinstance(identity, dict) else None
    core_matches = isinstance(identity, dict) and all((
        identity.get("runId") == resource.get("run_id"),
        identity.get("operationId") == resource.get("operation_id"),
        identity.get("role") == resource.get("role"),
        identity.get("selectedModel") == resource.get("model"),
        identity.get("agent") == resource.get("acp_agent"),
        identity.get("sessionName") == resource.get("acpx_session"),
        identity.get("agentFsSession") == resource.get("agentfs_session"),
    ))
    if not using_herdr():
        verified = core_matches and isinstance(presentation, dict) and presentation.get("kind") == "headless" and resource.get("tab") is None and resource.get("pane") is None
        return {"transport": "headless", "presentationVerified": verified, "herdrVisible": False, "identityMatches": verified}
    pane_result = run(["herdr", "pane", "get", str(resource["pane"])]).stdout
    try:
        pane = json.loads(pane_result)["result"]["pane"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise DelegateError(f"invalid Herdr pane observation: {error}") from error
    identity_matches = core_matches and isinstance(presentation, dict) and all((
        presentation.get("kind") == "herdr",
        presentation.get("agent") == resource.get("agent"),
        presentation.get("tabId") == resource.get("tab"),
        presentation.get("paneId") == resource.get("pane"),
    ))
    visible = pane.get("pane_id") == resource.get("pane") and pane.get("tab_id") == resource.get("tab")
    return {"transport": "herdr", "presentationVerified": visible and identity_matches, "herdrVisible": visible, "identityMatches": identity_matches}


def close_acpx_attempt(resource: dict[str, Any]) -> dict[str, Any]:
    closed = run_acpx_again(resource, None, "close", "close")
    if closed.get("processExitCode") != 0 or closed.get("closed") is not True or closed.get("noSession") is not True:
        raise DelegateError(f"ACPX session close failed: {closed}")
    verify_provider_links(resource)
    if using_herdr():
        run([
            "herdr", "pane", "release-agent", str(resource["pane"]),
            "--source", "pi-agent-wave-acpx", "--agent", str(resource["agent"]),
            "--seq", "4",
        ], check=False)
    return closed



def configuration_self_writes(resource: dict[str, Any]) -> list[dict[str, Any]]:
    """Tolerated configuration self-writes observed by provider verification, in file-name order."""
    observed = resource.get("configuration_self_writes")
    if not isinstance(observed, dict):
        return []
    return [observed[name] for name in sorted(observed)]



def parse_json_action(output: str, action: str) -> dict[str, Any] | None:
    for line in reversed(output.strip().splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("action") == action:
            return value
    return None


def run_structured_cancel(resource: dict[str, Any]) -> dict[str, Any]:
    completed = run([str(resource["acpx_cancel_script"])])
    result = parse_json_action(completed.stdout, "cancel_attempt")
    if completed.returncode != 0 or result is None:
        raise DelegateError(completed.stderr.strip() or "structured ACPX cancellation failed")
    expected_identity = {
        "sessionName": resource["acpx_session"],
        "recordId": resource["acpx_record_id"],
        "attemptKey": resource["acpx_attempt_key"],
    }
    if any(result.get(key) != value for key, value in expected_identity.items()):
        raise DelegateError("structured ACPX cancellation returned mismatched attempt identity")
    required = ["cancelled", "structuredCancelled", "closed", "noSession"]
    if any(result.get(name) is not True for name in required):
        raise DelegateError("structured ACPX cancellation did not prove cancel_result, cancelled terminal, session_closed, and no-session")
    return result


FAILURE_DIAGNOSTIC_EVENT_LIMIT = 20
FAILURE_DIAGNOSTIC_EVENT_CHARS = 500
FAILURE_DIAGNOSTIC_STDERR_BYTES = 4096
FAILURE_DIAGNOSTIC_REDACTIONS = (
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY"), "[redacted]"),
    # Provider keys are not all Anthropic-shaped: the keychain-resolved key on the author's host is
    # `sk-` prefixed, 114 characters, and contains dots, which the pattern above does not match.
    (re.compile(r"\bsk-[A-Za-z0-9._~+/=-]{16,}"), "[redacted]"),
    (re.compile(r"\b[A-Z0-9_]*(TOKEN|API_KEY|SECRET)[A-Z0-9_]*\b\s*[=:]\s*[^\s,\"]+"), "[redacted]"),
    # ACP agents announce the signed-in account; the bundle is retained on disk, so identity is stripped too.
    (re.compile('("(?:email|accountId|account_id)"\\s*:\\s*)"[^"]*"'), '\\1"[redacted]"'),
)


def redact_failure_text(value: str) -> str:
    """Masks credential-shaped material with the production secret-scan pattern plus token assignments."""
    for pattern, replacement in FAILURE_DIAGNOSTIC_REDACTIONS:
        value = pattern.sub(replacement, value)
    return value


def _read_text_tail(path: Path, limit: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return redact_failure_text(text[-limit:])


def _recent_worker_events(path: Path, limit: int) -> list[object]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    events: list[object] = []
    for line in lines[-limit:]:
        try:
            events.append(json.loads(redact_failure_text(line)[:FAILURE_DIAGNOSTIC_EVENT_CHARS]))
        except json.JSONDecodeError:
            events.append(redact_failure_text(line[:FAILURE_DIAGNOSTIC_EVENT_CHARS]))
    return events



def write_failure_diagnostics(resource: dict[str, Any], reason: str) -> Path | None:
    """Retain a bounded private diagnostic bundle before the attempt directory is removed."""
    attempt_dir = Path(str(resource.get("attempt_dir", "")))
    run_dir = Path(str(resource.get("run_dir", "")))
    if not attempt_dir.is_dir() or not run_dir.is_dir():
        return None
    result: object = {}
    result_path = attempt_dir / "worker-result.json"
    if result_path.exists():
        try:
            result = json.loads(redact_failure_text(result_path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            result = {"unreadable": True}
    terminal = result.get("terminal") if isinstance(result, dict) else None
    suffix = str(resource.get("operation_id") or attempt_dir.name)
    changed_configuration = []
    for index, item in enumerate(resource.get("provider_links", [])):
        if item.get("kind") != "snapshot":
            continue
        link = Path(str(item["link"]))
        if link.name == "setup-token":
            continue
        try:
            roots = [attempt_dir.resolve(), Path(str(resource.get("acpx_home", attempt_dir))).resolve()]
            if link.is_symlink() or not link.is_file() or not any(link.resolve().is_relative_to(root) for root in roots):
                continue
            data = link.read_bytes()
            observed = hashlib.sha256(data).hexdigest()
            if observed == item["sha256"]:
                continue
            retained = run_dir / f"changed-configuration-{suffix}-{index}-{link.name}"
            write_private_bytes(retained, data)
            changed_configuration.append({"name": link.name, "expectedSha256": item["sha256"], "observedSha256": observed, "retainedPath": str(retained)})
        except OSError as error:
            changed_configuration.append({"name": link.name, "retentionError": type(error).__name__})
    bundle = {
        "schemaVersion": 1,
        "runId": resource.get("run_id"),
        "operationId": resource.get("operation_id"),
        "agentName": resource.get("agent"),
        "node": resource.get("node"),
        "role": resource.get("role"),
        "acpAgent": resource.get("acp_agent"),
        "selectedModel": resource.get("selected_model"),
        "acpxSession": resource.get("acpx_session"),
        "agentFsSession": resource.get("agentfs_session"),
        "attemptKey": resource.get("acpx_attempt_key"),
        "reason": redact_failure_text(reason)[:2000],
        "processExitCode": result.get("processExitCode") if isinstance(result, dict) else None,
        "terminalKind": terminal.get("kind") if isinstance(terminal, dict) else None,
        "workerResult": result,
        "agentFsSnapshot": resource.get("agentfs_snapshot"),
        "workerExit": resource.get("worker_exit"),
        "changedConfiguration": changed_configuration,
        "stderrTail": _read_text_tail(attempt_dir / "worker.stderr.txt", FAILURE_DIAGNOSTIC_STDERR_BYTES),
        "recentEvents": _recent_worker_events(attempt_dir / "worker.stdout.ndjson", FAILURE_DIAGNOSTIC_EVENT_LIMIT),
    }
    path = run_dir / f"failure-{suffix}.json"
    write_private(path, json.dumps(bundle, indent=2, sort_keys=True) + "\n")
    return path


def without_target_paths(text: str) -> str:
    """Reduce absolute path tokens to their basename so credential targets never reach a log or report."""
    return re.sub(r"(?:/[A-Za-z0-9._:@+~-]+){2,}", lambda match: Path(match.group(0)).name, text)


def abort_acpx_attempt(resource: dict[str, Any], cancel_attempt: Any = run_structured_cancel, provider_verifier: Any = verify_provider_links, command_runner: Any = run, tab_closer: Any = close_created_tab, remove_tree: Any = None) -> list[str]:
    failures: list[str] = []
    write_failure_diagnostics(resource, "attempt aborted before cleanup")
    launcher = Path(str(resource.get("acpx_cancel_script", "")))
    # A teardown only has something to cancel while the attempt launcher still exists; a repeat
    # cleanup after a completed teardown must converge instead of reporting an absent launcher.
    if str(resource.get("acpx_session", "")) and launcher.is_file():
        try:
            cancel_result = cancel_attempt(resource)
            if isinstance(cancel_result, dict) and cancel_result.get("noSession") is True:
                resource["session_closure"] = "cancel-proved"
        except Exception as error:
            failures.append(f"ACPX cancel/close error: {without_target_paths(str(error))}")
    remaining_links = [Path(str(link.get("link") if isinstance(link, dict) else link)) for link in resource.get("provider_links", []) if str(link)]
    # Absence is the desired teardown end state, so integrity is only verified while a link is still there.
    if any(os.path.lexists(link) for link in remaining_links):
        try:
            provider_verifier(resource)
        except Exception as error:
            failures.append("provider link verification failed: " + without_target_paths(str(error)))
    if using_herdr():
        released = command_runner([
            "herdr", "pane", "release-agent", str(resource["pane"]),
            "--source", "pi-agent-wave-acpx", "--agent", str(resource["agent"]),
        ], check=False)
        if released.returncode != 0:
            failures.append(f"Herdr agent release failed: {released.stderr.strip()}")
        try:
            tab_closer(Path(str(resource["run_dir"])), str(resource["tab"]))
        except Exception as error:
            failures.append(f"Herdr tab release failed: {error}")
    for owned_directory in [Path(str(resource["attempt_dir"])), Path(str(resource["acpx_home"]))]:
        if remove_tree is None:
            shutil.rmtree(owned_directory, ignore_errors=True)
        else:
            remove_tree(owned_directory)
        if owned_directory.exists():
            failures.append(f"owned directory still exists: {owned_directory}")
    return failures


def cleanup_absence_inventory(resource: dict[str, Any], tabs_output: str, pane_exists: bool, agent_exists: bool, process_output: str, mount_output: str) -> dict[str, Any]:
    tab_id = str(resource.get("tab", ""))
    session_name = str(resource.get("acpx_session", ""))
    attempt_dir = Path(str(resource.get("attempt_dir", "")))
    acpx_home = Path(str(resource.get("acpx_home", "")))
    agentfs_home = Path(str(resource.get("agentfs_home", "")))
    agentfs_db = Path(str(resource.get("agentfs_db_path", "")))
    process_lines = [line.strip() for line in process_output.splitlines()]
    def owned_process(line: str) -> bool:
        # Identify the Python entry point, not filenames in a worker's arbitrary arguments.
        # A launch-acpx.sh process still owns an execution and must settle before cleanup passes.
        matches_session = bool(session_name) and session_name in line
        matches_attempt = bool(str(attempt_dir)) and str(attempt_dir) != "." and str(attempt_dir) in line
        if not (matches_session or matches_attempt):
            return False
        try:
            arguments = shlex.split(line)[1:]  # ps prefixes the command with its PID.
        except ValueError:
            return True
        if arguments and re.fullmatch(r"python(?:[0-9]+(?:\.[0-9]+)*)?", Path(arguments[0]).name):
            script_args = arguments[1:]
            while script_args and script_args[0] in {"-u", "-B"}:
                script_args = script_args[1:]
            script = script_args[0] if script_args else ""
            if Path(script).name in {"herdr_delegate.py", "headless_delegate.py", "headless_supervisor.py"}:
                return False
        return True

    owned_processes = [line for line in process_lines if owned_process(line)]
    queue_owner = [line for line in owned_processes if "acpx" in line and ("queue" in line or session_name in line)]
    agentfs_servers = [line for line in owned_processes if "agentfs" in line]
    repair_children = [line for line in owned_processes if "repair" in line or "report" in line]
    provider_links = [Path(str(link.get("link") if isinstance(link, dict) else link)) for link in resource.get("provider_links", [])]
    return {
        "tabAbsent": tab_id not in tabs_output,
        "paneAbsent": not pane_exists,
        "agentAbsent": not agent_exists,
        "queueOwnerAbsent": not queue_owner,
        "acpxSessionFilesAbsent": not acpx_home.exists(),
        "agentFsMountAbsent": session_name not in mount_output and str(agentfs_home) not in mount_output,
        "agentFsServerAbsent": not agentfs_servers,
        "agentFsDatabaseAbsent": not agentfs_db.exists(),
        "agentFsHomeAbsent": not agentfs_home.exists(),
        "providerLinksAbsent": all(not os.path.lexists(link) for link in provider_links),
        "reportRepairChildAbsent": not repair_children,
        "attemptDirectoryAbsent": not attempt_dir.exists(),
        "ownedProcessesAbsent": not owned_processes,
        "ownedProcessMatches": owned_processes,
    }


def verify_cleanup_absence(run_dir: Path, resource: dict[str, Any], evidence_writer: Any = write_private) -> Path:
    if using_herdr():
        tabs = run(["herdr", "tab", "list", "--workspace", os.environ["HERDR_WORKSPACE_ID"]], check=False)
        pane = run(["herdr", "pane", "get", str(resource["pane"])], check=False)
        agent = run(["herdr", "agent", "get", str(resource["agent"])], check=False)
        tabs_output = tabs.stdout if tabs.returncode == 0 else str(resource["tab"])
        pane_exists = pane.returncode == 0
        agent_exists = agent.returncode == 0
    else:
        tabs_output = ""
        pane_exists = False
        agent_exists = False
    processes = run(["ps", "-axo", "pid=,command="], check=False)
    mounts = run(["mount"], check=False)
    inventory = cleanup_absence_inventory(resource, tabs_output, pane_exists, agent_exists, processes.stdout, mounts.stdout)
    # Closure is only ever recorded from an observation: a structured cancellation that proved
    # no-session, a verified session close, or a session that is gone from both files and processes.
    closure = resource.get("session_closure")
    if closure is None:
        closure = "files-and-processes-absent" if inventory.get("acpxSessionFilesAbsent") is True and inventory.get("ownedProcessesAbsent") is True else "unproven"
    evidence = {
        "schemaVersion": 1,
        "agent": resource["agent"],
        **inventory,
        "sessionClosed": closure in ("cancel-proved", "close-proved", "files-and-processes-absent"),
        "sessionClosureEvidence": closure,
    }
    required = ["tabAbsent", "paneAbsent", "agentAbsent", "queueOwnerAbsent", "acpxSessionFilesAbsent", "agentFsMountAbsent", "agentFsServerAbsent", "agentFsDatabaseAbsent", "agentFsHomeAbsent", "providerLinksAbsent", "reportRepairChildAbsent", "attemptDirectoryAbsent", "ownedProcessesAbsent", "sessionClosed"]
    failures = [key for key in required if evidence.get(key) is not True]
    if failures:
        raise DelegateError("cleanup absence audit failed: " + "; ".join(failures))
    evidence_path = run_dir / f"cleanup-{slugify(str(resource['agent']))}.json"
    evidence_writer(evidence_path, json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    return evidence_path


def command_wait(args: argparse.Namespace) -> None:
    if using_herdr():
        require_herdr()
    else:
        require_worker_runtime()
    run_dir = require_run_dir(args.run_dir)
    resource = owned_resource(run_dir, args.agent_name)
    print(json.dumps(settle_runtime_attempt(run_dir, resource), sort_keys=True))


def retain_incomplete_capture(run_dir: Path, resource: dict[str, Any], evidence_path: Path) -> Path | None:
    """Keep the raw worker stream as private evidence when capture was not complete or produced no candidate.

    The attempt directory is removed after a clean settlement, which left the 2026-09-12 operations smoke 3 with an
    exited, candidate-less synthesis attempt (`output-outside-prompt`) and nothing to diagnose it from.
    """
    try:
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    observation = evidence.get("observation") if isinstance(evidence, dict) else None
    status = observation.get("captureStatus") if isinstance(observation, dict) else None
    if status == "complete" and evidence.get("candidate") is not None:
        return None
    source = Path(str(resource.get("attempt_dir", ""))) / "worker.stdout.ndjson"
    if not source.is_file():
        return None
    retained = run_dir / f"runtime-capture-{slugify(str(resource['agent']))}.ndjson"
    write_private_bytes(retained, source.read_bytes())
    return retained


def settlement_base_dir(resource: dict[str, Any]) -> str:
    """The workspace the worker was dispatched in. Settlement may run from any directory (the supervisor's
    collect call does not change directory), so the current directory is never a substitute: the 2026-09-12
    build measurement staged against the supervisor's checkout and refused the real owned paths as escapes."""
    base_dir = resource.get("base_dir")
    if not isinstance(base_dir, str) or not base_dir:
        raise DelegateError("runtime settlement requires the dispatch working directory recorded at start (base_dir)")
    return base_dir


def settle_runtime_attempt(run_dir: Path, resource: dict[str, Any]) -> dict[str, Any]:
    """Retain the worker's answer and audited changes first; close, verify and clean up afterwards.

    Content retention is the essential commit: a session-close, provider-boundary or cleanup failure
    after it leaves the settlement record and its content in place and is reported as a
    post-settlement failure instead of discarding the attempt.
    """
    try:
        wait_for_settled_agent(run_dir, resource)
    except DelegateError as error:
        cleanup_failures = abort_acpx_attempt(resource)
        if cleanup_failures:
            error = DelegateError(f"{error}\n" + "\n".join(cleanup_failures))
        raise error
    evidence_path = run_dir / f"runtime-settlement-{slugify(str(resource['agent']))}.json"
    node_name = str(resource.get("node"))
    kind = "coding" if node_name == "implement" else "operational" if node_name == "source_search" else "research"
    post_settlement_failures: list[str] = []
    try:
        snapshot: Path | None = None
        if kind in ("coding", "operational"):
            if resource.get("read_only") is True:
                raise DelegateError(f"{kind} settlement requires an owned-write attempt")
            if kind == "coding" and not resource.get("base_revision"):
                raise DelegateError("coding settlement requires a Git base revision recorded at dispatch")
            snapshot = snapshot_agentfs_db(resource)
        settle_config = Path(str(resource["attempt_dir"])) / "runtime-settle.json"
        write_private(settle_config, json.dumps({
            "schemaVersion": 1,
            "attemptKey": resource["acpx_attempt_key"],
            "workerResultPath": resource["worker_result"],
            "kind": kind,
            "baseDir": settlement_base_dir(resource),
            "baseRevision": resource.get("base_revision") or "none",
            "checkpointPath": resource.get("checkpoint_path") if kind == "operational" else None,
            "ownedPaths": resource.get("owned_paths", []),
            "readOnly": resource.get("read_only") is True,
            "snapshotPath": str(snapshot) if snapshot else None,
            "agentFsExecutable": shutil.which("agentfs") or "agentfs",
            "evidencePath": str(evidence_path),
        }, indent=2, sort_keys=True) + "\n")
        if not evidence_path.exists():
            settled = run([NODE, "--experimental-strip-types", str(RUNTIME_SETTLE)], env={**os.environ, "PI_RUNTIME_SETTLE_CONFIG": str(settle_config)}, check=False)
            if settled.returncode != 0 or parse_json_action(settled.stdout, "runtime_settled") is None:
                raise DelegateError(f"runtime settlement failed: {redact_failure_text(settled.stderr[-FAILURE_DIAGNOSTIC_STDERR_BYTES:]) or settled.returncode}")
    except DelegateError as error:
        cleanup_failures = abort_acpx_attempt(resource)
        if cleanup_failures:
            error = DelegateError(f"{error}\n" + "\n".join(cleanup_failures))
        raise error
    capture_retained = retain_incomplete_capture(run_dir, resource, evidence_path)
    session_closed = False
    provider_links_verified = False
    try:
        presentation_observation = observe_presentation_identity(resource)
        if presentation_observation.get("presentationVerified") is not True or presentation_observation.get("identityMatches") is not True:
            raise DelegateError("worker presentation identity does not match the registered attempt")
        close_result = close_acpx_attempt(resource)
        resource["session_closure"] = "close-proved"
        session_closed = close_result.get("closed") is True and close_result.get("noSession") is True
        provider_links_verified = True
    except DelegateError as error:
        post_settlement_failures.append(without_target_paths(str(error)))
    cleanup_failures = abort_acpx_attempt(resource) if post_settlement_failures else []
    if not post_settlement_failures:
        shutil.rmtree(Path(str(resource["attempt_dir"])), ignore_errors=True)
        shutil.rmtree(Path(str(resource["acpx_home"])), ignore_errors=True)
    cleanup_evidence: Path | None = None
    try:
        cleanup_evidence = verify_cleanup_absence(run_dir, resource)
    except DelegateError as error:
        post_settlement_failures.append(str(error))
    post_settlement_failures.extend(cleanup_failures)
    return {
        "valid": True,
        "resultContract": "runtime-v1",
        "settlementEvidencePath": str(evidence_path),
        "captureRetainedPath": str(capture_retained) if capture_retained else None,
        "cleanupEvidencePath": str(cleanup_evidence) if cleanup_evidence else None,
        "sessionClosed": session_closed,
        "providerLinksVerified": provider_links_verified,
        "configurationSelfWrites": configuration_self_writes(resource),
        "postSettlementFailures": post_settlement_failures,
        "acpxSession": resource.get("acpx_session"),
        "agentFsSession": resource.get("agentfs_session"),
    }


def command_cleanup(args: argparse.Namespace) -> None:
    if using_herdr():
        require_herdr()
    else:
        require_worker_runtime()
    run_dir = require_run_dir(args.run_dir)
    tab_ids = list(dict.fromkeys(
        resource["tab"] for resource in read_state(run_dir)["resources"] if resource.get("tab")
    ))
    failures: list[str] = []
    cleanup_evidence: list[str] = []
    for resource in read_state(run_dir)["resources"]:
        if resource.get("execution") != "acpx-agentfs":
            continue
        # Teardown work is attempted only while an owned resource is still registered, so a repeat
        # cleanup of a torn-down attempt does not re-report absent resources as failures. The absence
        # audit then runs on every path, which is what makes convergence observable.
        if Path(str(resource.get("attempt_dir", ""))).exists() or Path(str(resource.get("acpx_cancel_script", ""))).is_file():
            failures.extend(abort_acpx_attempt(resource))
        try:
            cleanup_evidence.append(str(verify_cleanup_absence(run_dir, resource)))
        except DelegateError as error:
            failures.append(str(error))
    for tab_id in tab_ids:
        try:
            close_created_tab(run_dir, tab_id)
        except DelegateError as error:
            failures.append(str(error))
    shutil.rmtree(run_dir / "acpx", ignore_errors=True)
    if failures:
        raise DelegateError("\n".join(failures))
    print(json.dumps({"cleaned": str(run_dir), "cleanupEvidence": cleanup_evidence}, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    init_parser = commands.add_parser("init")
    init_parser.add_argument("run_label", nargs="?", default="delegate")
    init_parser.set_defaults(handler=command_init)

    start_parser = commands.add_parser("start")
    start_parser.add_argument("run_dir")
    start_parser.add_argument("role")
    start_parser.add_argument("selector", nargs="?")
    start_parser.add_argument("task_file", nargs="?")
    start_parser.add_argument("--policy", help="friendly frozen policy label")
    start_parser.add_argument("--policy-digest", default="")
    start_parser.add_argument("--tier", help="effective frozen tier")
    start_parser.add_argument("--chain", help="ordered comma-separated frozen model chain")
    start_parser.add_argument("--model", help="exact model lock (never falls back)")
    start_parser.add_argument("--reason", help="required reason for an exact model lock")
    start_parser.add_argument("--thinking")
    start_parser.add_argument("--session", help="true or false")
    start_parser.add_argument("--node", help="exact Delegate Graph node")
    start_parser.add_argument("--command-json", help="structured operational command with executable, args, and cwd")
    start_parser.add_argument("--run-id", help="Delegate Graph run ID")
    start_parser.add_argument("--operation-id", help="Delegate Graph operation ID")
    start_parser.add_argument("--owned-paths-json", help="JSON array of graph-owned paths")
    start_parser.add_argument("--ignored-paths-json", help="JSON array of overlay paths discarded without export or violation; defaults to no ignored paths")
    start_parser.add_argument("--access-mode", choices=("read-only", "owned-write"), help="persisted graph operation access mode; legacy launches default to read-only except implement/source_search")
    start_parser.add_argument("--model-attempt", type=int, default=0)
    start_parser.add_argument("--transient-attempt", type=int, default=0)
    start_parser.add_argument("--fallback-reason")
    start_parser.add_argument("--no-terminal", action="store_true", help="disable ACP terminal capability for evidence-only review")
    start_parser.add_argument("--task-file", dest="task_file_option")
    start_parser.set_defaults(handler=command_start)

    wait_parser = commands.add_parser("wait")
    wait_parser.add_argument("run_dir")
    wait_parser.add_argument("agent_name")
    wait_parser.set_defaults(handler=command_wait)

    cleanup_parser = commands.add_parser("cleanup")
    cleanup_parser.add_argument("run_dir")
    cleanup_parser.set_defaults(handler=command_cleanup)
    return parser


def main(transport: str | None = None) -> None:
    global ACTIVE_TRANSPORT
    if transport is not None:
        if transport not in {"headless", "herdr"}:
            fail(f"unsupported delegate transport {transport}")
        ACTIVE_TRANSPORT = transport
    args = build_parser().parse_args()
    try:
        args.handler(args)
    except DelegateError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
