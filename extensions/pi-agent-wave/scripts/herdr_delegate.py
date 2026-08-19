#!/usr/bin/env python3
"""Launch and supervise visible Delegate Graph Pi agents in Herdr tabs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
RESOLVER = SCRIPT_DIR / "resolve-model.mjs"
REPORT_AUDIT = SCRIPT_DIR / "report-audit.ts"
REPORT_PROMPT = SCRIPT_DIR / "report-prompt.ts"
NODE = shutil.which("node") or "node"
TMP_ROOT = Path("/tmp").resolve()
RUN_PREFIX = "delegate-graph-herdr-"
WAIT_TIMEOUT_MS = "3600000"
START_READY_TIMEOUT_SECONDS = 10.0
START_RETRY_SECONDS = 0.2
ROLE_NODES = {
    "thinker": "thinker_plan",
    "implementer": "implement",
    "reviewer": "review",
    "tester": "test",
    "auditor": "audit",
    "searcher": "search",
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
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        check=False,
        text=True,
        capture_output=capture,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "no diagnostic output").strip()
        raise DelegateError(f"command failed ({result.returncode}): {argv!r}\n{detail}")
    return result


def require_herdr() -> None:
    if os.environ.get("HERDR_ENV") != "1":
        raise DelegateError("Herdr-visible delegation requires HERDR_ENV=1")
    for variable in ("HERDR_WORKSPACE_ID", "HERDR_TAB_ID"):
        if not os.environ.get(variable):
            raise DelegateError(f"Herdr-visible delegation requires {variable}")
    if shutil.which("herdr") is None:
        raise DelegateError("Herdr-visible delegation requires the herdr command")


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


def write_private(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


def write_state(run_dir: Path, state: dict[str, Any]) -> None:
    temporary = run_dir / ".state.json.tmp"
    write_private(temporary, json.dumps(state, indent=2, sort_keys=True) + "\n")
    temporary.replace(run_dir / "state.json")
    (run_dir / "state.json").chmod(0o600)


def json_path(payload: str, *keys: str) -> Any:
    value: Any = json.loads(payload)
    for key in keys:
        value = value[key]
    return value


def close_created_tab(run_dir: Path, tab_id: str) -> None:
    state = read_state(run_dir)
    if tab_id == state["caller_tab"]:
        raise DelegateError(f"refusing to close caller tab {tab_id}")
    if tab_id in state["closed_tabs"]:
        return
    run(["herdr", "tab", "close", tab_id])
    state["closed_tabs"].append(tab_id)
    write_state(run_dir, state)


def command_init(args: argparse.Namespace) -> None:
    require_herdr()
    ensure_pi_integration()
    slug = slugify(args.run_label)
    run_dir = Path(tempfile.mkdtemp(prefix=f"{RUN_PREFIX}{slug}.", dir=TMP_ROOT))
    run_dir.chmod(0o700)
    write_state(
        run_dir,
        {
            "caller_tab": os.environ["HERDR_TAB_ID"],
            "closed_tabs": [],
            "resources": [],
            "run_label": args.run_label,
            "run_slug": slug,
        },
    )
    write_private(
        run_dir / "system-prompt.txt",
        "You are a Delegate Graph leaf agent. Execute only the assigned task using "
        "available tools. Do not delegate recursively. Follow the assigned JSON report "
        "contract exactly. The report file is the sole verdict source.\n",
    )
    print(run_dir)


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


TRANSIENT_LAUNCH_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b429\b", re.I), "http-429"),
    (re.compile(r"\b50[0-4]\b", re.I), "http-5xx"),
    (re.compile(r"rate[ -]?limit", re.I), "rate-limit"),
    (re.compile(r"\bquota\b", re.I), "quota"),
    (re.compile(r"overload(?:ed)?", re.I), "overloaded"),
    (re.compile(r"ETIMEDOUT|timed? out", re.I), "timeout"),
    (re.compile(r"ECONNRESET|connection reset", re.I), "connection-reset"),
    (re.compile(r"connection[- ]closed|provider unavailable", re.I), "connection-closed"),
)


def classify_launch_failure(message: str) -> tuple[str, str]:
    for pattern, reason in TRANSIENT_LAUNCH_PATTERNS:
        if pattern.search(message):
            return "transient", reason
    return "permanent", "unclassified"


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


def command_start(args: argparse.Namespace) -> None:
    require_herdr()
    ensure_pi_integration()
    run_dir = require_run_dir(args.run_dir)
    route = frozen_route(args)

    report_value = args.report_option or args.report
    task_value = args.task_file_option or args.task_file
    # Exact locks can omit the legacy tier selector: shift the two positional paths.
    if args.model and not task_value and args.selector and args.report:
        report_value, task_value = args.selector, args.report
    if not report_value or not task_value:
        raise DelegateError("start requires a report path and task file")
    report_input = Path(report_value)
    if not report_input.is_absolute():
        raise DelegateError("delegate report must be an absolute path under /tmp")
    report = report_input.resolve()
    try:
        report.relative_to(TMP_ROOT)
    except ValueError as error:
        raise DelegateError("delegate report must be an absolute path under /tmp") from error
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
    first_label = (
        f"{state['run_label']}: {role_label} [{route['policy']}] "
        f"@ {chain[0].rsplit('/', 1)[-1]}"
    )
    environment = delegation_environment(route, args.role, first_label, chain[0])
    tab_result = run(
        tab_create_argv(
            os.environ["HERDR_WORKSPACE_ID"], os.getcwd(), first_label, environment
        )
    ).stdout
    tab_id = str(json_path(tab_result, "result", "tab", "tab_id"))
    pane_id = str(json_path(tab_result, "result", "root_pane", "pane_id"))

    resource = {
        "agent": agent_name,
        "pane": pane_id,
        "report": str(report),
        "report_root": str(report.parent),
        "role": args.role,
        "node": node,
        "role_label": role_label,
        "tab": tab_id,
        "policy": route["policy"],
        "policy_digest": route["policy_digest"],
        "tier": route["tier"],
        "model": chain[0],
        "model_attempt": 0,
        "chain_length": len(chain),
        "fallback_reason": None,
        "model_lock_reason": route["lock_reason"],
        "report_repair_attempts": 0,
        "report_repair_diagnostics": [],
    }
    state["resources"].append(resource)
    write_state(run_dir, state)

    selected_model = chain[0]
    selected_attempt = 0
    fallback_reason: str | None = None
    try:
        for attempt, model in enumerate(chain):
            selected_model = model
            selected_attempt = attempt
            label = (
                f"{state['run_label']}: {role_label} [{route['policy']}] "
                f"@ {model.rsplit('/', 1)[-1]}"
            )
            if attempt:
                run(["herdr", "tab", "rename", tab_id, label])
            start_argv = [
                "herdr",
                "agent",
                "start",
                agent_name,
                "--kind",
                "pi",
                "--pane",
                pane_id,
                "--timeout",
                "300000",
                "--",
                "--model",
                model,
                "--thinking",
                route["thinking"],
                "--append-system-prompt",
                str(run_dir / "system-prompt.txt"),
                "--name",
                label,
            ]
            if not route["session"]:
                start_argv.append("--no-session")
            try:
                start_agent_when_ready(start_argv)
                break
            except DelegateError as error:
                kind, reason = classify_launch_failure(str(error))
                if route["exact"]:
                    raise DelegateError(
                        f"exact model lock {model!r} failed; fallback unavailable ({reason})\n{error}"
                    ) from error
                if kind != "transient" or attempt + 1 >= len(chain):
                    raise
                fallback_reason = reason
        else:
            raise DelegateError("frozen model chain exhausted")

        resource.update(
            {
                "model": selected_model,
                "model_attempt": selected_attempt,
                "fallback_reason": fallback_reason,
            }
        )
        write_state(run_dir, state)
        report_contract = run(
            [NODE, "--experimental-strip-types", str(REPORT_PROMPT), "--node", node, "--report", str(report)]
        ).stdout.strip()
        task_instruction = (
            f"Read and execute the complete assigned task in {task_file.resolve()}. "
            "Follow that file exactly.\n\n" + report_contract
        )
        run(
            [
                "herdr",
                "agent",
                "prompt",
                agent_name,
                task_instruction,
                "--wait",
                "--until",
                "working",
                "--timeout",
                "10000",
            ]
        )
    except Exception:
        try:
            close_created_tab(run_dir, tab_id)
        except Exception as cleanup_error:
            print(f"failed to clean up tab {tab_id}: {cleanup_error}", file=sys.stderr)
        raise

    print(
        json.dumps(
            {
                "agent": agent_name,
                "policy": route["policy"],
                "policy-digest": route["policy_digest"],
                "tier": route["tier"],
                "model": selected_model,
                "model-attempt": selected_attempt,
                "chain-length": len(chain),
                "fallback-reason": fallback_reason,
                "model-lock-reason": route["lock_reason"],
                "pane": pane_id,
                "report": str(report),
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


def wait_for_settled_agent(run_dir: Path, resource: dict[str, Any]) -> None:
    agent_name = str(resource["agent"])
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
        if status in {"idle", "done", "blocked"}:
            close_settled_tab(run_dir, resource, error)
        raise error

    agent_result = run(["herdr", "agent", "get", agent_name]).stdout
    status = str(json_path(agent_result, "result", "agent", "agent_status"))
    if status not in {"idle", "done", "blocked"}:
        raise DelegateError(f"Herdr agent settled in unsupported state {status!r}: {agent_name}")
    if status == "blocked":
        close_settled_tab(run_dir, resource, DelegateError(f"Herdr agent is blocked: {agent_name}"))


def audit_resource_report(run_dir: Path, resource: dict[str, Any]) -> dict[str, Any]:
    result = run(
        [
            NODE,
            "--experimental-strip-types",
            str(REPORT_AUDIT),
            "--report",
            str(resource["report"]),
            "--node",
            str(resource["node"]),
            "--private-root",
            str(resource["report_root"]),
        ],
        check=False,
    )
    try:
        audit = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise DelegateError(f"report auditor returned invalid JSON: {error}") from error
    if not isinstance(audit, dict):
        raise DelegateError("report auditor returned a non-object result")
    return audit


def record_repair_attempt(run_dir: Path, agent_name: str, attempt: int, diagnostics: list[Any]) -> None:
    state = read_state(run_dir)
    for resource in reversed(state["resources"]):
        if resource["agent"] == agent_name:
            resource["report_repair_attempts"] = attempt
            resource.setdefault("report_repair_diagnostics", []).append(diagnostics)
            write_state(run_dir, state)
            return
    raise DelegateError(f"agent is not owned by this run: {agent_name}")


def command_wait(args: argparse.Namespace) -> None:
    require_herdr()
    run_dir = require_run_dir(args.run_dir)
    resource = owned_resource(run_dir, args.agent_name)
    repair_attempts = int(resource.get("report_repair_attempts", 0))
    while True:
        wait_for_settled_agent(run_dir, resource)
        audit = audit_resource_report(run_dir, resource)
        if audit.get("valid") is True:
            audit["reportRepairAttempts"] = repair_attempts
            audit["reportRepairDiagnostics"] = resource.get("report_repair_diagnostics", [])
            print(json.dumps(audit, sort_keys=True))
            close_settled_tab(run_dir, resource)
            return
        if repair_attempts >= 1:
            final_diagnostics = audit.get("errors", [])
            record_repair_attempt(run_dir, args.agent_name, repair_attempts, final_diagnostics)
            resource.setdefault("report_repair_diagnostics", []).append(final_diagnostics)
            error = DelegateError(
                "delegate report rejected after one repair attempt: "
                + json.dumps(final_diagnostics, sort_keys=True)
            )
            close_settled_tab(run_dir, resource, error)
        repair_attempts += 1
        diagnostics = audit.get("errors", [])
        record_repair_attempt(run_dir, args.agent_name, repair_attempts, diagnostics)
        resource.setdefault("report_repair_diagnostics", []).append(diagnostics)
        repair_prompt = run(
            [
                NODE,
                "--experimental-strip-types",
                str(REPORT_PROMPT),
                "--node",
                str(resource["node"]),
                "--report",
                str(resource["report"]),
                "--repair-json",
                json.dumps(diagnostics),
            ]
        ).stdout.strip()
        run(
            [
                "herdr",
                "agent",
                "prompt",
                args.agent_name,
                repair_prompt,
                "--wait",
                "--until",
                "working",
                "--timeout",
                "10000",
            ]
        )


def command_cleanup(args: argparse.Namespace) -> None:
    require_herdr()
    run_dir = require_run_dir(args.run_dir)
    tab_ids = list(dict.fromkeys(
        resource["tab"] for resource in read_state(run_dir)["resources"]
    ))
    failures: list[str] = []
    for tab_id in tab_ids:
        try:
            close_created_tab(run_dir, tab_id)
        except DelegateError as error:
            failures.append(str(error))
    if failures:
        raise DelegateError("\n".join(failures))
    print(json.dumps({"cleaned": str(run_dir)}, sort_keys=True))


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
    start_parser.add_argument("report", nargs="?")
    start_parser.add_argument("task_file", nargs="?")
    start_parser.add_argument("--policy", help="friendly frozen policy label")
    start_parser.add_argument("--policy-digest", default="")
    start_parser.add_argument("--tier", help="effective frozen tier")
    start_parser.add_argument("--chain", help="ordered comma-separated frozen model chain")
    start_parser.add_argument("--model", help="exact model lock (never falls back)")
    start_parser.add_argument("--reason", help="required reason for an exact model lock")
    start_parser.add_argument("--thinking")
    start_parser.add_argument("--session", help="true or false")
    start_parser.add_argument("--node", help="exact Delegate Graph node for report verdict validation")
    start_parser.add_argument("--report", dest="report_option")
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


def main() -> None:
    args = build_parser().parse_args()
    try:
        args.handler(args)
    except DelegateError as error:
        fail(str(error))


if __name__ == "__main__":
    main()
