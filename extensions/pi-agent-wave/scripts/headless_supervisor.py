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
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stream_endpoint import StreamPublisher, probe_stream_endpoint, publish_private_file, resolve_stream_backend


def drain(stream, target, publisher=None) -> None:
    """Copies the worker's output line by line, so the file and the live channel both advance as it runs.

    A fixed-size `read` blocks until the buffer fills or the process exits, which made both sinks arrive
    only at the end; a stream nobody can read until the worker is gone is a capture, not a live view.
    """
    try:
        for line in iter(stream.readline, ""):
            if not line:
                break
            target.write(line)
            target.flush()
            if publisher is not None:
                publisher.publish(line)
    finally:
        stream.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--launcher", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--stdout", required=True)
    parser.add_argument("--stderr", required=True)
    parser.add_argument("--status", required=True)
    # Where the live stream's bearer token is written. Absent, the worker runs with no live channel,
    # which is what an older caller and the cancellation launcher both do.
    parser.add_argument("--stream-token", default=None)
    parser.add_argument("--stream-endpoint", default=None)
    args = parser.parse_args()
    stdout_path = Path(args.stdout)
    stderr_path = Path(args.stderr)
    status_path = Path(args.status)
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    publisher = None
    if args.stream_token:
        resolve_stream_backend()
        probe_stream_endpoint()
        publisher = StreamPublisher(Path(args.stream_token))
        if args.stream_endpoint:
            endpoint = Path(args.stream_endpoint)
            # Atomic: a subscriber polls for this descriptor, and a truncated read would fail it.
            publish_private_file(endpoint, json.dumps({"schemaVersion": 1, "backend": resolve_stream_backend(), "host": publisher.host, "port": publisher.port}, sort_keys=True) + "\n")
    with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open("w", encoding="utf-8") as stderr_file:
        script = shutil.which("script")
        if script is None:
            raise RuntimeError("headless transport requires the private PTY executable 'script'")
        pty_argv = [script, "-q", "/dev/null", args.launcher] if platform.system() == "Darwin" else [script, "-q", "-c", shlex.quote(args.launcher), "/dev/null"]
        worker = subprocess.Popen(pty_argv, cwd=args.cwd, env=None, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=False)
        assert worker.stdout is not None and worker.stderr is not None
        stdout_thread = threading.Thread(target=drain, args=(worker.stdout, stdout_file, publisher), daemon=True)
        stderr_thread = threading.Thread(target=drain, args=(worker.stderr, stderr_file), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        exit_code = worker.wait()
        if worker.stdin is not None:
            worker.stdin.close()
        stdout_thread.join()
        stderr_thread.join()
    if publisher is not None:
        publisher.close()
        if args.stream_endpoint:
            Path(args.stream_endpoint).unlink(missing_ok=True)
    status_path.write_text(json.dumps({"schemaVersion": 1, "workerPid": worker.pid, "exitCode": exit_code}, sort_keys=True) + "\n", encoding="utf-8")
    status_path.chmod(0o600)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
