#!/usr/bin/env python3
"""Run a graph worker with operator-registered host services beside it.

Usage: host_service_launcher.py --spec <attached.json> --state-root <dir> -- <worker argv...>

Runs on the host, outside the worker's sandbox. Each service gets a free loopback port and a private state
directory under --state-root, is started in its own process group, and must accept connections on its port
before the worker starts. The worker receives each service's expanded `env` entries. When the worker exits,
or this launcher is told to stop, every service's process group is stopped. `running.json` under --state-root
lists the live services, each with its start time, so `delegate_core.stop_host_services` can stop them if this
launcher is killed outright without signalling a process that has since reused a pid.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

NOT_READY_EXIT = 70
STOP_GRACE_SECONDS = 5.0
RUNNING_FILE = "running.json"
FORWARDED_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)


class Stopped(Exception):
    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def expand(value: str, port: int, state_dir: Path) -> str:
    return value.replace("{port}", str(port)).replace("{stateDir}", str(state_dir))


def accepting(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def last_line(path: Path) -> str:
    try:
        lines = [line.strip() for line in path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    except OSError:
        return ""
    return lines[-1][:300] if lines else ""


def write_running(state_root: Path, running: list[dict[str, Any]]) -> None:
    target = state_root / RUNNING_FILE
    temporary = state_root / f".{RUNNING_FILE}.tmp"
    temporary.write_text(json.dumps([{key: entry[key] for key in ("name", "pid", "started", "executable")} for entry in running], indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, target)


def start_time(pid: int) -> str:
    """The process's start time as `ps` reports it; with the pid it identifies the process across a re-exec."""
    return subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, check=False).stdout.strip()


# macOS answers a signal to a process group whose remaining members are all zombies with EPERM rather than
# ESRCH. Every member of a service's group is this user's, so either error means nothing is left to stop.
GROUP_GONE = (ProcessLookupError, PermissionError)


def stop_group(process: subprocess.Popen[bytes]) -> None:
    """SIGTERM the service's process group, then SIGKILL whatever is left after the grace period."""
    for signum, grace in ((signal.SIGTERM, STOP_GRACE_SECONDS), (signal.SIGKILL, STOP_GRACE_SECONDS)):
        try:
            os.killpg(process.pid, signum)
        except GROUP_GONE:
            break
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except GROUP_GONE:
                return
            time.sleep(0.05)
    process.poll()


def stop_all(state_root: Path, running: list[dict[str, Any]]) -> None:
    """Stops every service even if one stop fails; `running.json` is kept for the backstop when any stop failed."""
    failed = False
    for entry in reversed(running):
        try:
            stop_group(entry["process"])
        except Exception as error:
            failed = True
            print(f"host service {entry['name']} could not be stopped: {error}", file=sys.stderr)
    if not failed:
        (state_root / RUNNING_FILE).unlink(missing_ok=True)


def start_service(service: dict[str, Any], state_root: Path) -> dict[str, Any]:
    name = str(service["name"])
    port = free_port()
    state_dir = state_root / name
    state_dir.mkdir(mode=0o700, parents=True)
    log_path = state_root / f"{name}.log"
    argv = [str(service["executable"]), *(expand(str(arg), port, state_dir) for arg in service["args"])]
    with open(log_path, "ab") as log:
        process = subprocess.Popen(argv, cwd=state_dir, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    env = {str(key): expand(str(value), port, state_dir) for key, value in dict(service.get("env", {})).items()}
    return {"name": name, "pid": process.pid, "started": start_time(process.pid), "executable": argv[0], "process": process, "port": port, "env": env, "log": log_path, "timeout": int(service["readyTimeoutSeconds"])}


def wait_ready(entry: dict[str, Any]) -> str | None:
    """None once the service accepts connections; otherwise why it never will."""
    deadline = time.monotonic() + entry["timeout"]
    while time.monotonic() < deadline:
        if accepting(entry["port"]):
            return None
        code = entry["process"].poll()
        if code is not None:
            return f"exited with status {code}"
        time.sleep(0.1)
    return f"did not accept connections on its port within {entry['timeout']}s"


def run(spec: list[dict[str, Any]], state_root: Path, worker_argv: list[str]) -> int:
    state_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    running: list[dict[str, Any]] = []
    worker: subprocess.Popen[bytes] | None = None

    def on_signal(signum: int, _frame: object) -> None:
        if worker is None:
            raise Stopped(signum)
        try:
            worker.send_signal(signum)
        except ProcessLookupError:
            pass

    for signum in FORWARDED_SIGNALS:
        signal.signal(signum, on_signal)
    try:
        for service in spec:
            entry = start_service(service, state_root)
            running.append(entry)
            write_running(state_root, running)
            problem = wait_ready(entry)
            if problem:
                detail = last_line(entry["log"])
                print(f"host service {entry['name']} did not become ready: {problem}" + (f"; last log line: {detail}" if detail else ""), file=sys.stderr)
                return NOT_READY_EXIT
        environment = dict(os.environ)
        for entry in running:
            environment.update(entry["env"])
        worker = subprocess.Popen(worker_argv, env=environment)
        while True:
            try:
                code = worker.wait()
                break
            except InterruptedError:
                continue
        return code if code >= 0 else 128 - code
    except Stopped as stopped:
        return 128 + stopped.signum
    finally:
        for signum in FORWARDED_SIGNALS:
            signal.signal(signum, signal.SIG_IGN)
        stop_all(state_root, running)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--state-root", required=True, type=Path)
    parser.add_argument("worker", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    worker_argv = args.worker[1:] if args.worker[:1] == ["--"] else args.worker
    if not worker_argv:
        parser.error("a worker command is required after --")
    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    if not isinstance(spec, list):
        parser.error("--spec must hold a JSON array of attached services")
    sys.exit(run(spec, args.state_root, worker_argv))


if __name__ == "__main__":
    main()
