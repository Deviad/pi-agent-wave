#!/usr/bin/env python3
"""Owns and drains a detached worker's stdio for its complete process lifetime."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import threading


def drain(stream, target) -> None:
    try:
        for chunk in iter(lambda: stream.read(8192), ""):
            if not chunk:
                break
            target.write(chunk)
            target.flush()
    finally:
        stream.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--stdout", required=True)
    parser.add_argument("--stderr", required=True)
    parser.add_argument("--status", required=True)
    args = parser.parse_args()
    stdout_path = Path(args.stdout)
    stderr_path = Path(args.stderr)
    status_path = Path(args.status)
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
        script = shutil.which("script")
        if script is None:
            raise RuntimeError("headless transport requires the private PTY executable 'script'")
        pty_argv = [script, "-q", "/dev/null", args.launcher] if platform.system() == "Darwin" else [script, "-q", "-c", shlex.quote(args.launcher), "/dev/null"]
        worker = subprocess.Popen(pty_argv, cwd=args.cwd, env=None, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=False)
        assert worker.stdout is not None and worker.stderr is not None
        stdout_thread = threading.Thread(target=drain, args=(worker.stdout, stdout_file), daemon=True)
        stderr_thread = threading.Thread(target=drain, args=(worker.stderr, stderr_file), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        exit_code = worker.wait()
        if worker.stdin is not None:
            worker.stdin.close()
        stdout_thread.join()
        stderr_thread.join()
    status_path.write_text(json.dumps({"schemaVersion": 1, "workerPid": worker.pid, "exitCode": exit_code}, sort_keys=True) + "\n", encoding="utf-8")
    status_path.chmod(0o600)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
