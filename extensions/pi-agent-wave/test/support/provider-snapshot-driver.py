#!/usr/bin/env python3
"""Drives provider credential materialization against a fake `pi` command runner."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py"
spec = importlib.util.spec_from_file_location("delegate_core", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

SENTINEL_KEY = "sentinel-resolved-api-key-value"


class FakeCompleted:
    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def layout(case: str) -> tuple[Path, Path, Path, object]:
    root = Path(tempfile.mkdtemp(prefix=f"provider-snapshot-{case}-"))
    real_home = root / "home"
    agent = real_home / ".pi" / "agent"
    agent.mkdir(parents=True)
    if case == "live-entry":
        (agent / "auth.json").write_text(json.dumps({
            "alibaba": {"type": "api_key", "key": "live-stored-key-value"},
            "anthropic": {"type": "oauth", "access": "a", "refresh": "r", "expires": 1},
        }))
    else:
        (agent / "auth.json").write_text(json.dumps({
            "anthropic": {"type": "oauth", "access": "a", "refresh": "r", "expires": 1},
        }))
    (agent / "models.json").write_text("{}")
    attempt = root / "attempt"
    attempt.mkdir()
    acpx_home = root / "acpx-home"
    acpx_home.mkdir()

    seen_env: list[object] = []

    def command(args: list[str], **kwargs: object) -> FakeCompleted:
        seen_env.append(kwargs.get("env"))
        if args[1:3] == ["auth", "check"]:
            if case in ("preflight-fail", "no-credential", "check-fail-key-ok"):
                return FakeCompleted(0, json.dumps({"status": "not_ready", "provider": "alibaba", "reason": "provider_not_found"}))
            return FakeCompleted(0, json.dumps({"status": "ready", "provider": "alibaba", "authType": "api_key"}))
        if args[1:3] == ["auth", "print-api-key"]:
            if case in ("preflight-fail", "no-credential"):
                return FakeCompleted(1, "", "cannot resolve")
            return FakeCompleted(0, SENTINEL_KEY + "\n")
        raise AssertionError(f"unexpected command: {args}")

    return root, attempt, acpx_home, command, seen_env


def snapshot(case: str) -> dict[str, object]:
    root, attempt, acpx_home, command, seen_env = layout(case)
    decoy_agent_dir = os.environ.get("PI_CODING_AGENT_DIR")
    decoy = "/decoy-agent-dir-that-must-not-be-used"
    os.environ["PI_CODING_AGENT_DIR"] = decoy
    private = attempt / "providers" / "pi-agent" / "auth.json"
    live = root / "home" / ".pi" / "agent" / "auth.json"
    live_before = live.read_bytes()
    error: str | None = None
    links: list[dict[str, str]] = []
    try:
        try:
            _env, links = module.provider_runtime_environment(attempt, acpx_home, root / "home", "alibaba/qwen3.8-flash", command_runner=command)
        except module.DelegateError as failure:
            error = str(failure)
        record = next((item for item in links if Path(item["link"]).name == "auth.json"), None)

        def verify() -> str | None:
            if record is None:
                return "no auth.json record"
            try:
                module.verify_provider_links({"provider_links": [record]})
            except module.DelegateError as failure:
                return str(failure)
            return None

        verification = verify()
        created_exists = private.exists()
        created_is_symlink = private.is_symlink()
        created_is_regular = private.is_file() and not private.is_symlink()
        created_mode = oct(private.stat().st_mode & 0o777) if created_exists else None
        body: dict[str, object] = {}
        if private.exists():
            body = json.loads(private.read_text(encoding="utf-8"))
        refresh_verification: str | None = None
        provider_set_tamper: str | None = None
        mode_tamper: str | None = None
        symlink_tamper: str | None = None
        if record is not None and private.exists():
            recorded_mode = private.stat().st_mode & 0o777
            private.write_text(json.dumps({"alibaba": {"type": "api_key", "key": "refreshed-secret-value"}}), encoding="utf-8")
            os.chmod(private, recorded_mode)
            refresh_verification = verify()
            private.write_text(json.dumps({"anthropic": {"type": "oauth", "access": "a"}}), encoding="utf-8")
            os.chmod(private, recorded_mode)
            provider_set_tamper = verify()
            private.write_text(json.dumps({"alibaba": {"type": "api_key", "key": "restored"}}), encoding="utf-8")
            os.chmod(private, 0o644)
            mode_tamper = verify()
            os.chmod(private, recorded_mode)
            elsewhere = root / "elsewhere.json"
            elsewhere.write_text("{}", encoding="utf-8")
            private.unlink()
            private.symlink_to(elsewhere)
            symlink_tamper = verify()
        after_tamper = provider_set_tamper
        return {
            "case": case,
            "error": error,
            "exists": created_exists,
            "isSymlink": created_is_symlink,
            "isRegular": created_is_regular,
            "mode": created_mode,
            "providers": sorted(body.keys()),
            "entryFields": sorted(body.get("alibaba", {}).keys()) if isinstance(body.get("alibaba"), dict) else [],
            "entryType": body.get("alibaba", {}).get("type") if isinstance(body.get("alibaba"), dict) else None,
            "resolvedKeyMatches": body.get("alibaba", {}).get("key") == SENTINEL_KEY if isinstance(body.get("alibaba"), dict) else False,
            "liveUnchanged": live.read_bytes() == live_before,
            "liveHasSentinel": SENTINEL_KEY in live.read_text(encoding="utf-8"),
            "recordKind": record.get("kind") if record else None,
            "recordTarget": record.get("target") if record else None,
            "verification": verification,
            "afterTamper": after_tamper,
            "refreshVerification": refresh_verification,
            "providerSetTamper": provider_set_tamper,
            "modeTamper": mode_tamper,
            "symlinkTamper": symlink_tamper,
            "recordKeySet": json.loads(record["keySet"]) if record and record.get("keySet") and record["keySet"] != "unparseable" else None,
            "preflightEnvHome": (seen_env[0] or {}).get("HOME") if seen_env and isinstance(seen_env[0], dict) else None,
            "preflightEnvAgentDir": (seen_env[0] or {}).get("PI_CODING_AGENT_DIR") if seen_env and isinstance(seen_env[0], dict) else None,
            "inheritedAgentDir": decoy_agent_dir,
            "decoyAgentDir": decoy,
        }
    finally:
        if decoy_agent_dir is None:
            os.environ.pop("PI_CODING_AGENT_DIR", None)
        else:
            os.environ["PI_CODING_AGENT_DIR"] = decoy_agent_dir
        shutil.rmtree(root, ignore_errors=True)


def materialization_case(case: str) -> dict[str, object]:
    """Codex and Claude credential files must be private copies, not links into the live store."""
    root = Path(tempfile.mkdtemp(prefix=f"credential-copy-{case}-"))
    home = root / "home"
    (home / ".pi" / "agent").mkdir(parents=True)
    (home / ".pi" / "agent" / "auth.json").write_text("{}", encoding="utf-8")
    attempt = root / "attempt"
    attempt.mkdir()
    acpx_home = root / "acpx-home"
    acpx_home.mkdir()

    if case == "codex":
        (home / ".codex").mkdir()
        live = home / ".codex" / "auth.json"
        live.write_text(json.dumps({"auth_mode": "chatgpt", "OPENAI_API_KEY": None, "tokens": {"access_token": "access", "refresh_token": "refresh"}, "last_refresh": "now"}), encoding="utf-8")
        model = "openai-codex/gpt-6-astra"
        private = attempt / "providers" / "codex" / "auth.json"
    else:
        (home / ".claude").mkdir()
        live = home / ".claude" / ".credentials.json"
        live.write_text(json.dumps({"claudeAiOauth": {"accessToken": "access", "refreshToken": "refresh", "expiresAt": 1}}), encoding="utf-8")
        os.chmod(live, 0o600)
        model = "claude-code/claude-opus-5"
        private = attempt / "providers" / "claude" / ".credentials.json"
    live_before = live.read_bytes()

    error: str | None = None
    links: list[dict[str, str]] = []
    try:
        try:
            _env, links = module.provider_runtime_environment(
                attempt, acpx_home, home, model,
                command_runner=lambda argv, **kwargs: FakeCompleted(0, json.dumps({"status": "ready"})),
            )
        except module.DelegateError as failure:
            error = str(failure)
        record = next((item for item in links if Path(item["link"]) == private), None)

        def verify() -> str | None:
            if record is None:
                return "no record"
            try:
                module.verify_provider_links({"provider_links": [record]})
            except module.DelegateError as failure:
                return str(failure)
            return None

        created_is_symlink = private.is_symlink()
        created_is_regular = private.is_file() and not private.is_symlink()
        created_mode = oct(private.stat().st_mode & 0o777) if private.exists() else None
        created_keys = sorted(json.loads(private.read_text(encoding="utf-8")).keys()) if private.exists() else []
        verification = verify()
        refresh_verification = key_set_tamper = None
        if record is not None and private.exists():
            body = json.loads(private.read_text(encoding="utf-8"))
            first = sorted(body.keys())[0]
            body[first] = "refreshed-value"
            private.write_text(json.dumps(body), encoding="utf-8")
            os.chmod(private, 0o600)
            refresh_verification = verify()
            del body[first]
            private.write_text(json.dumps(body), encoding="utf-8")
            os.chmod(private, 0o600)
            key_set_tamper = verify()
        return {
            "case": case,
            "error": error,
            "isSymlink": created_is_symlink,
            "isRegular": created_is_regular,
            "mode": created_mode,
            "recordKind": record.get("kind") if record else None,
            "recordKeySet": json.loads(record["keySet"]) if record and record.get("keySet") else None,
            "createdKeys": created_keys,
            "liveUnchanged": live.read_bytes() == live_before,
            "verification": verification,
            "refreshVerification": refresh_verification,
            "keySetTamper": key_set_tamper,
        }
    finally:
        shutil.rmtree(root, ignore_errors=True)


AGENT_MODELS = [
    "openai-codex/gpt-6-astra",
    "claude-code/claude-opus-5",
    "alibaba/qwen3.8-flash",
    "z.ai-sub/glm-5.2",
    "lmstudio/qwen3.6-27b-mlx",
]


def agent_case() -> dict[str, object]:
    return {"agents": {model: module.agent_for_model(model) for model in AGENT_MODELS}}


def credential_case(case: str) -> dict[str, object]:
    root = Path(tempfile.mkdtemp(prefix=f"agent-credential-{case}-"))
    home = root / "home"
    (home / ".pi" / "agent").mkdir(parents=True)
    (home / ".pi" / "agent" / "auth.json").write_text("{}", encoding="utf-8")
    codex_home = root / "codex-home"
    codex_home.mkdir()
    saved_codex = os.environ.get("CODEX_HOME")
    saved_claude = os.environ.get("PI_CLAUDE_OAUTH_TOKEN_FILE")
    os.environ["CODEX_HOME"] = str(codex_home)
    os.environ.pop("PI_CLAUDE_OAUTH_TOKEN_FILE", None)
    try:
        if case == "codex-ok-chatgpt":
            (codex_home / "auth.json").write_text(json.dumps({
                "auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                "tokens": {"access_token": "access", "refresh_token": "refresh"},
            }), encoding="utf-8")
        elif case == "codex-ok-apikey":
            (codex_home / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "key"}), encoding="utf-8")
        elif case == "codex-empty":
            (codex_home / "auth.json").write_text("{}", encoding="utf-8")
        elif case == "codex-unparseable":
            (codex_home / "auth.json").write_text("{not json", encoding="utf-8")
        elif case == "claude-token-file":
            token = root / "claude-token"
            token.write_text("token", encoding="utf-8")
            os.chmod(token, 0o600)
            os.environ["PI_CLAUDE_OAUTH_TOKEN_FILE"] = str(token)
        elif case == "claude-credentials-file":
            (home / ".claude").mkdir()
            credentials = home / ".claude" / ".credentials.json"
            credentials.write_text("{}", encoding="utf-8")
            os.chmod(credentials, 0o600)
        elif case in ("codex-missing", "claude-missing", "codex-wiring"):
            pass
        else:
            raise ValueError(case)

        agent = "claude" if case.startswith("claude") else "codex"
        model = "claude-code/claude-opus-5" if agent == "claude" else "openai-codex/gpt-6-astra"
        auth_type: str | None = None
        error: str | None = None
        if case != "codex-wiring":
            try:
                auth_type = module.preflight_agent_credentials(agent, module.provider_from_model(model), model, home)
            except module.DelegateError as failure:
                error = str(failure)

        wiring: str | None = None
        if case == "codex-wiring":
            attempt = root / "attempt"
            attempt.mkdir()
            acpx_home = root / "acpx-home"
            acpx_home.mkdir()
            try:
                module.provider_runtime_environment(
                    attempt, acpx_home, home, model,
                    command_runner=lambda argv, **kwargs: FakeCompleted(0, json.dumps({"status": "ready"})),
                )
            except module.DelegateError as failure:
                wiring = str(failure)
        return {"case": case, "agent": agent, "authType": auth_type, "error": error, "wiring": wiring}
    finally:
        if saved_codex is None:
            os.environ.pop("CODEX_HOME", None)
        else:
            os.environ["CODEX_HOME"] = saved_codex
        if saved_claude is not None:
            os.environ["PI_CLAUDE_OAUTH_TOKEN_FILE"] = saved_claude
        shutil.rmtree(root, ignore_errors=True)


mode, case = sys.argv[1:3]
if mode == "snapshot":
    print(json.dumps(snapshot(case), sort_keys=True))
elif mode == "agent":
    print(json.dumps(agent_case(), sort_keys=True))
elif mode == "credential":
    print(json.dumps(credential_case(case), sort_keys=True))
elif mode == "materialization":
    print(json.dumps(materialization_case(case), sort_keys=True))
else:
    raise SystemExit(f"usage: {sys.argv[0]} snapshot|agent|credential <case>")
