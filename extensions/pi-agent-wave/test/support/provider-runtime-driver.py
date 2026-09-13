"""Exercise production provider isolation using temporary homes and real files."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("delegate_core", Path(__file__).resolve().parents[2] / "scripts" / "delegate_core.py")
assert spec and spec.loader
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def verify(records):
    return verify_with({"provider_links": records}, records)


def verify_with(resource, records):
    resource["provider_links"] = records
    try:
        core.verify_provider_links(resource)
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
    catalog_refresh = None
    if agent == "pi":
        private_catalog = attempt / "providers" / "pi-agent" / "models-store.json"
        original_catalog = private_catalog.read_bytes()
        writer = "const {FileModelsStore} = await import(process.argv[1]); const store = new FileModelsStore(process.argv[2]); await store.write('fixture', {models: [], checkedAt: 1}); console.log(JSON.stringify(await store.read('fixture')));"
        refreshed = subprocess.run(["node", "--input-type=module", "-e", writer, sys.argv[2], str(private_catalog)], check=True, capture_output=True, text=True)
        catalog_refresh = {"verification": verify(records), "changed": private_catalog.read_bytes() != original_catalog, "liveUnchanged": catalog.read_text() == configs[catalog], "readBack": json.loads(refreshed.stdout) == {"models": [], "checkedAt": 1}}
    destinations = [str(Path(r["link"]).relative_to(root)) for r in records]
    runtime_copies = [r for r in records if Path(r["link"]).name not in ("auth.json", ".credentials.json")]
    copies = [Path(r["link"]).is_file() and not Path(r["link"]).is_symlink() for r in runtime_copies]
    modes = [oct(Path(r["link"]).stat().st_mode & 0o777) for r in runtime_copies]
    config_matched = agent != "codex" or (attempt / "providers" / "codex" / "config.toml").read_bytes() == (Path(os.environ["CODEX_HOME"]) / "config.toml").read_bytes()
    selected = [(Path(r["link"]), Path(r["link"]).read_bytes()) for r in runtime_copies]
    for file in configs:
        file.write_text("changed live source\n")
    token.write_text("changed live token\n")
    after_sources = verify(records)
    unchanged = all(file.read_bytes() == original for file, original in selected)
    mutations = []
    for record, private_copy in zip(runtime_copies, copies):
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
        mutations.append({"mutableCatalog": record["kind"] == "catalog-cache", "changed": changed, "mode": mode, "specialMode": special_mode, "missing": missing, "link": link})
    # Claude's JSON configuration may be rewritten by Claude itself (2026-09-12 decision): a value change, a
    # removed key or an added key passes and is recorded; a non-JSON body, a JSON array or a symlink still fails.
    self_writes = None
    if agent == "claude":
        tolerated = [r for r in records if r.get("selfWrites") == "tolerated"]
        settings_record = next(r for r in tolerated if Path(r["link"]).name == "settings.json")
        claude_json_record = next(r for r in tolerated if Path(r["link"]).name == ".claude.json")
        settings_file, claude_json_file = Path(settings_record["link"]), Path(claude_json_record["link"])
        original_settings, original_claude_json = settings_file.read_bytes(), claude_json_file.read_bytes()
        settings_file.write_bytes(b'{"added": {"nested": true}}\n')
        claude_json_file.write_bytes(b'{"promptQueueUseCount": 2}\n')
        resource = {"provider_links": tolerated}
        rewritten = verify_with(resource, tolerated)
        recorded = core.configuration_self_writes(resource)
        settings_file.write_bytes(b"not json\n")
        not_json = verify([settings_record])
        settings_file.write_bytes(b"[1, 2]\n")
        not_object = verify([settings_record])
        settings_file.write_bytes(original_settings)
        untouched_resource = {"provider_links": tolerated}
        claude_json_file.write_bytes(original_claude_json)
        restored = verify_with(untouched_resource, tolerated)
        self_writes = {"tolerated": sorted(Path(r["link"]).name for r in tolerated), "rewritten": rewritten, "recorded": recorded, "notJson": not_json, "notObject": not_object, "restored": restored, "restoredRecorded": core.configuration_self_writes(untouched_resource)}
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
    preserved = root / "retained"
    preserved.mkdir(mode=0o700)
    record = next(r for r in records if r["kind"] == "snapshot" and Path(r["link"]).name != "setup-token" and Path(r["link"]).is_relative_to(attempt))
    changed_bytes = b'{"fixture":"changed configuration"}\n'
    Path(record["link"]).write_bytes(changed_bytes)
    for item in records:
        if item["kind"] == "file" or Path(item["link"]).name == "setup-token":
            Path(item["link"]).write_text("private-token-fixture")
    outside = root / "outside-config"
    outside.write_text("outside-secret-fixture")
    linked = attempt / "linked-config"
    linked.symlink_to(outside)
    records.extend([{**record, "link": str(linked)}, {**record, "link": str(outside)}])
    core.ACTIVE_TRANSPORT = "headless"
    core.abort_acpx_attempt({"attempt_dir": str(attempt), "acpx_home": str(acpx_home), "run_dir": str(preserved), "operation_id": "fixture", "provider_links": records})
    bundle = json.loads((preserved / "failure-fixture.json").read_text())
    retained = bundle.get("changedConfiguration", [])
    retained_file = Path(retained[0]["retainedPath"]) if retained else None
    observed = retained_file.read_bytes() if retained_file else b""
    all_evidence = b"".join(f.read_bytes() for f in preserved.iterdir() if f.is_file())
    retention = {"cleanupRemoved": not attempt.exists() and not acpx_home.exists(), "count": len(retained), "exact": observed == changed_bytes, "mode": oct(retained_file.stat().st_mode & 0o777) if retained_file else None, "hashesMatch": bool(retained) and retained[0]["expectedSha256"] == record["sha256"] and retained[0]["observedSha256"] == hashlib.sha256(observed).hexdigest(), "privateDataLeaked": b"private-token-fixture" in all_evidence or b"outside-secret-fixture" in all_evidence}
    print(json.dumps({"selfWrites": self_writes, "catalogRefresh": catalog_refresh, "retention": retention, "agent": agent, "before": before, "afterCatalog": after_catalog, "afterSources": after_sources, "copies": copies, "modes": modes, "configMatched": config_matched, "unchanged": unchanged, "destinations": destinations, "claudeTokenEnvironment": "PI_CLAUDE_OAUTH_TOKEN_FILE" in environment, "mutations": mutations, "credentialSpecialMode": credential_special_mode, "legacyBefore": legacy_before, "legacyAfter": verify([legacy])}))
