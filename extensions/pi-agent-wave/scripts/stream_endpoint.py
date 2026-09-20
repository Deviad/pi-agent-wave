#!/usr/bin/env python3
"""The live stream channel for a headless worker: one endpoint resolver and one loopback publisher.

A headless worker has no pane, so the only way to watch it live is a channel the host-side supervisor
publishes. This is a live stream and nothing else: it retains no history beyond the bounded backlog a
late subscriber needs to see where the worker is, and it writes no artifact except the bearer token.

The backend is chosen by one resolver so no caller invents its own, mirroring the rule `AGENTS.md`
already sets for `agent_for_model()` / `agentForModel()` / `selectAcpAgent()`. Every supported platform
resolves to `loopback-tcp`: a `127.0.0.1` listener on an ephemeral port is identical on macOS, Linux and
Windows, while a Unix domain socket under a run directory would exceed the 103/107-byte `sun_path` limit
and a FIFO would be POSIX-only and would hang any directory scan that touched it.
"""

from __future__ import annotations

import errno
import os
import platform
import secrets
import socket
import threading
from collections import deque
from pathlib import Path

# Supported publishing backends. There is one, deliberately: see the module docstring.
LOOPBACK_TCP = "loopback-tcp"

SUPPORTED_PLATFORMS = ("Darwin", "Linux", "Windows")

STREAM_HOST = "127.0.0.1"
# What a subscriber joining late is shown before live lines start. A window, never a replay: the file
# capture is the record, this channel is the view.
STREAM_BACKLOG_LINES = 200
TOKEN_BYTES = 32


def publish_private_file(path: Path, content: str) -> None:
    """Writes a private file atomically: a reader that polls for the path must never see it half-written.

    `Path.write_text` truncates and then writes, so a poller that keys on existence can read an empty or
    partial file. The result file of a runtime attempt had the same defect and was fixed the same way.
    """
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(handle, content.encode("utf-8"))
        os.fsync(handle)
    finally:
        os.close(handle)
    os.replace(temporary, path)
    path.chmod(0o600)


def resolve_stream_backend(system: str | None = None) -> str:
    """The publishing backend for a platform. Every supported platform uses the same loopback listener."""
    name = system or platform.system()
    if name not in SUPPORTED_PLATFORMS:
        raise ValueError(f"unsupported platform for the live worker stream: {name}")
    return LOOPBACK_TCP


def probe_stream_endpoint(host: str = STREAM_HOST) -> None:
    """Fails with a named blocker when a loopback listener cannot be bound.

    The restricted host in `tasks/prd-runtime-owned-results.md` returns EPERM for a fresh loopback bind,
    so this is a checked prerequisite rather than an assumption, probed before dispatch the way
    `assertUsableRunRoot` probes the run root.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((host, 0))
    except OSError as error:
        raise RuntimeError(f"live worker stream unavailable: cannot bind a loopback listener on {host} ({errno.errorcode.get(error.errno, error.errno)})") from error
    finally:
        probe.close()


class StreamPublisher:
    """Publishes the worker's stdout to loopback subscribers for as long as the supervisor runs.

    Ownership is the supervisor's because it is the outermost host-side process: it already drains the
    worker's stdout for the attempt's lifetime and lives outside the AgentFS sandbox, so no sandbox
    binding question arises and the worker needs no change. The listener dies with the supervisor.
    """

    def __init__(self, token_path: Path, host: str = STREAM_HOST, backlog_lines: int = STREAM_BACKLOG_LINES) -> None:
        self._token = secrets.token_hex(TOKEN_BYTES)
        self._backlog: deque[str] = deque(maxlen=backlog_lines)
        self._subscribers: list[socket.socket] = []
        self._lock = threading.Lock()
        self._closed = False
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind((host, 0))
        self._server.listen(8)
        self.host, self.port = self._server.getsockname()[:2]
        publish_private_file(token_path, f"{self._token}\n")
        self._token_path = token_path
        self._accepting = threading.Thread(target=self._accept_loop, daemon=True)
        self._accepting.start()

    @property
    def token(self) -> str:
        return self._token

    def _accept_loop(self) -> None:
        while True:
            try:
                connection, _ = self._server.accept()
            except OSError:
                return
            threading.Thread(target=self._greet, args=(connection,), daemon=True).start()

    def _greet(self, connection: socket.socket) -> None:
        """Admits a subscriber that presents the token, then hands it the backlog window."""
        try:
            connection.settimeout(5.0)
            presented = connection.recv(len(self._token) + 2).decode("utf-8", "replace").strip()
            if not secrets.compare_digest(presented, self._token):
                connection.sendall(b"unauthorized\n")
                connection.close()
                return
            # Never blocking from here on: this socket is about to be written from the drain thread.
            connection.setblocking(False)
            with self._lock:
                if self._closed:
                    connection.close()
                    return
                backlog = "".join(self._backlog)
                self._subscribers.append(connection)
            if backlog:
                self._send(connection, backlog.encode("utf-8"))
        except OSError:
            try:
                connection.close()
            except OSError:
                pass

    def _send(self, connection: socket.socket, data: bytes) -> bool:
        """One non-blocking write. False means the subscriber is gone or cannot keep up.

        A subscriber is never allowed to slow the worker down, so a socket whose buffer is full is
        dropped rather than waited for: a blocking `sendall` here holds the drain thread, which stops
        the capture file and backpressures the worker's PTY until the reader resumes. A viewer that
        stalls must lose its view, not stall the run.
        """
        try:
            connection.sendall(data)
            return True
        except (BlockingIOError, OSError):
            return False

    def publish(self, chunk: str) -> None:
        """Offers one chunk of worker output to every subscriber, without ever waiting for one."""
        if not chunk:
            return
        data = chunk.encode("utf-8")
        with self._lock:
            self._backlog.append(chunk)
            subscribers = list(self._subscribers)
        dropped = [connection for connection in subscribers if not self._send(connection, data)]
        if not dropped:
            return
        with self._lock:
            self._subscribers = [connection for connection in self._subscribers if connection not in dropped]
        for connection in dropped:
            try:
                connection.close()
            except OSError:
                pass

    def close(self) -> None:
        """Ends the channel with the supervisor: the listener closes, subscribers drop, the token is removed."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            subscribers, self._subscribers = self._subscribers, []
        for connection in subscribers:
            try:
                connection.close()
            except OSError:
                pass
        try:
            self._server.close()
        except OSError:
            pass
        self._token_path.unlink(missing_ok=True)
