"""Exercise settlement ordering with real AgentFS export and a model-session boundary double."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import delegate_core as core

core.ACTIVE_TRANSPORT = "headless"
mode = sys.argv[1]
run_dir = Path(sys.argv[2])
resource_file = run_dir / "fixture-resource.json"

if mode == "prepare":
    base, private = run_dir / "base", run_dir / "private"
    base.mkdir()
    private.mkdir()
    (base / "owned.txt").write_text("original\n")
    home = private / "provider-home"
    (home / ".codex").mkdir(parents=True)
    (home / ".codex" / "auth.json").write_text(json.dumps({"OPENAI_API_KEY": "offline-fixture-not-a-credential"}))
    (home / ".codex" / "config.toml").write_text('model = "fixture-model"\n')
    os.environ["HOME"] = str(home)
    os.environ["CODEX_HOME"] = str(home / ".codex")
    os.environ.pop("PI_CLAUDE_OAUTH_TOKEN_FILE", None)
    os.chdir(base)
    model = "openai-codex/gpt-6-astra"
    args = core.build_parser().parse_args(["start", str(run_dir), "implementer", "--node", "implement", "--model", model, "--owned-paths-json", json.dumps([str(base / "owned.txt")])])
    task = private / "task.md"
    task.write_text("Temporary fixture only; do not request a model.")
    report = private / "report.json"
    resource, _ = core.prepare_acpx_attempt(run_dir, args, {"run_label": "config-export-fixture"}, "fixture-worker", model, report, task, "implement", "fixture contract")
    resource.update({"run_dir": str(run_dir), "agent": "fixture-worker", "role": "implementer", "node": "implement", "execution": "acpx-agentfs", "report": str(report), "report_root": str(private), "model": model})
    assert core.observe_presentation_identity(resource)["presentationVerified"] is True
    core.write_private(report, json.dumps({"schemaVersion": 1, "verdict": "DONE", "claims": [{"statement": "Fixture model report for settlement-order verification only", "evidence": [{"kind": "command", "source": "temporary AgentFS fixture", "detail": "Controlled model-output boundary; actual export is exercised separately"}], "verification": "unverified"}]}))
    core.write_state(run_dir, {"resources": [resource]})
    resource_file.write_text(json.dumps(resource))
    print(json.dumps(resource))
else:
    resource = json.loads(resource_file.read_text())
    if mode == "tampered":
        config = next(Path(item["link"]) for item in resource["provider_links"] if Path(item["link"]).name == "config.toml")
        config.write_text('model = "substituted"\n')

    if mode == "identity":
        state = core.read_state(run_dir)
        state["resources"][0]["attempt_identity"]["operationId"] = "foreign-operation"
        core.write_state(run_dir, state)

    class ExportReached(Exception):
        pass

    def stop_after_export(*_args):
        raise ExportReached()

    def close_presentation(_run, _resource, error=None):
        if error:
            raise error

    core.wait_for_settled_agent = lambda *_args: None
    core.close_acpx_attempt = lambda *_args: {"sessionClosed": True}
    core.abort_acpx_attempt = lambda *_args: []
    core.close_settled_tab = close_presentation
    core.write_and_audit_attempt_ledger = stop_after_export
    error = None
    exported = False
    try:
        core.command_wait(argparse.Namespace(run_dir=str(run_dir), agent_name="fixture-worker"))
    except ExportReached:
        exported = True
    except core.DelegateError as failure:
        error = str(failure)
    print(json.dumps({"exported": exported, "error": error, "hostBytes": (run_dir / "base" / "owned.txt").read_text()}))
