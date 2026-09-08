"""Exercise production provider isolation using temporary homes and real files."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

spec = importlib.util.spec_from_file_location("delegate_core", Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py")
assert spec and spec.loader
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def verify(records):
    try:
        core.verify_provider_links({"provider_links": records})
    except core.DelegateError as error:
        return str(error)
    return None


with tempfile.TemporaryDirectory(prefix="provider-runtime-") as directory:
    root = Path(directory)
    home, attempt, acpx_home = (root / name for name in ("home", "attempt", "acpx"))
    for folder in (home / ".pi" / "agent", home / ".codex", home / ".claude", attempt, acpx_home):
        folder.mkdir(parents=True)
    configs = {
        home / ".pi" / "agent" / "models.json": "{}\n",
        home / ".pi" / "agent" / "models-store.json": "{}\n",
        home / ".pi" / "agent" / "model-routing.jsonc": "{}\n",
        home / ".codex" / "config.toml": 'model = "fixture-model"\n',
        home / ".claude.json": "{}\n",
        home / ".claude" / "settings.json": "{}\n",
    }
    for file, content in configs.items():
        file.write_text(content)
    (home / ".pi" / "agent" / "auth.json").write_text(json.dumps({"alibaba": {"type": "api_key", "key": "offline-fixture-not-a-credential"}}))
    (home / ".codex" / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "offline-fixture-not-a-credential"}))
    (home / ".claude" / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "offline-fixture"}}))
    token = home / "claude-token"
    token.write_text("offline-token\n")
    token.chmod(0o600)
    os.environ["CODEX_HOME"] = str(home / ".codex")
    os.environ["PI_CLAUDE_OAUTH_TOKEN_FILE"] = str(token)
    agent = "codex" if sys.argv[1] == "codex-custom" else sys.argv[1]
    if sys.argv[1] == "codex-custom":
        custom = root / "custom-codex"
        custom.mkdir()
        (custom / "auth.json").write_bytes((home / ".codex" / "auth.json").read_bytes())
        configs[custom / "config.toml"] = 'model = "custom-fixture-model"\n'
        (custom / "config.toml").write_text(configs[custom / "config.toml"])
        os.environ["CODEX_HOME"] = str(custom)
    models = {"pi": "alibaba/qwen3.8-flash", "codex": "openai-codex/gpt-6-astra", "claude": "claude-code/claude-opus-5"}
    environment, records = core.provider_runtime_environment(attempt, acpx_home, home, models[agent])
    before = verify(records)
    catalog = home / ".pi" / "agent" / "models-store.json"
    catalog.write_text('{"changed":true}\n')
    after_catalog = verify(records)
    catalog.write_text(configs[catalog])
    destinations = [str(Path(r["link"]).relative_to(root)) for r in records]
    immutable = [r for r in records if Path(r["link"]).name not in ("auth.json", ".credentials.json")]
    copies = [Path(r["link"]).is_file() and not Path(r["link"]).is_symlink() for r in immutable]
    modes = [oct(Path(r["link"]).stat().st_mode & 0o777) for r in immutable]
    config_matched = agent != "codex" or (attempt / "providers" / "codex" / "config.toml").read_bytes() == (Path(os.environ["CODEX_HOME"]) / "config.toml").read_bytes()
    selected = [(Path(r["link"]), Path(r["link"]).read_bytes()) for r in immutable]
    for file in configs:
        file.write_text("changed live source\n")
    token.write_text("changed live token\n")
    after_sources = verify(records)
    unchanged = all(file.read_bytes() == original for file, original in selected)
    mutations = []
    for record, private_copy in zip(immutable, copies):
        if not private_copy:
            continue
        file = Path(record["link"])
        original = file.read_bytes()
        file.write_bytes(original + b"tampered")
        changed = verify([record])
        file.write_bytes(original)
        file.chmod(0o644)
        mode = verify([record])
        file.chmod(0o1600)
        special_mode = verify([record])
        file.chmod(0o600)
        file.unlink()
        missing = verify([record])
        file.symlink_to(token)
        link = verify([record])
        file.unlink()
        file.write_bytes(original)
        file.chmod(0o600)
        mutations.append({"changed": changed, "mode": mode, "specialMode": special_mode, "missing": missing, "link": link})
    credential = next(r for r in records if r["kind"] == "file")
    credential_file = Path(credential["link"])
    credential_file.chmod(0o1600)
    credential_special_mode = verify([credential])
    credential_file.chmod(0o600)
    legacy_source = root / "legacy-source"
    legacy_source.write_text("original")
    legacy_link = root / "legacy-link"
    legacy_link.symlink_to(legacy_source)
    legacy = {"kind": "symlink", "link": str(legacy_link), "target": str(legacy_source), "sha256": hashlib.sha256(legacy_source.read_bytes()).hexdigest(), "mode": oct(legacy_source.stat().st_mode & 0o777)}
    legacy_before = verify([legacy])
    legacy_source.write_text("changed")
    print(json.dumps({"agent": agent, "before": before, "afterCatalog": after_catalog, "afterSources": after_sources, "copies": copies, "modes": modes, "configMatched": config_matched, "unchanged": unchanged, "destinations": destinations, "claudeTokenEnvironment": "PI_CLAUDE_OAUTH_TOKEN_FILE" in environment, "mutations": mutations, "credentialSpecialMode": credential_special_mode, "legacyBefore": legacy_before, "legacyAfter": verify([legacy])}))
