import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts", import.meta.url));

function python(script: string, ...args: string[]) {
	return spawnSync("python3", ["-c", script, scripts, ...args], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PI_DELEGATE_WAIT_TIMEOUT_MS: "20000", PI_DELEGATE_WORKER_EXIT_TIMEOUT_MS: "5000" } });
}

const prelude = `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
core.ACTIVE_TRANSPORT = 'headless'
root = Path(sys.argv[2])
home = root / 'home'; (home / '.codex').mkdir(parents=True)
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
os.environ['HOME'] = str(home); os.environ['CODEX_HOME'] = str(home / '.codex'); os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
base = root / 'base'; base.mkdir(); private = root / 'private'; private.mkdir(mode=0o700)
os.chdir(base)
model = 'openai-codex/gpt-5.6-sol'
task = private / 'task.md'; task.write_text('Fixture task; no model is dispatched.'); task.chmod(0o600)
`;

describe("runtime-v1 Python lifecycle", () => {
	test("start prepares a report-free prompt and a worker config that selects the runtime contract", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-py-start-"));
		try {
			const result = python(prelude + `
out = {}
for contract in ['runtime-v1']:
    argv = ['start', str(private), 'searcher', '--node', 'search', '--model', model, '--access-mode', 'read-only']
    args = core.build_parser().parse_args(argv)
    resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'contract-fixture'}, f'fixture-{contract}', model, task, 'search', thinking='high')
for level, label in ((None, 'default'), ('off', 'off')):
    p = root / f'private-{label}'; p.mkdir(mode=0o700)
    r, _ = core.prepare_acpx_attempt(p, args, {'run_label': 'thinking-fixture'}, f'fixture-{label}', model, task, 'search', thinking=level)
    out[f'thinking-{label}'] = json.loads((Path(r['attempt_dir']) / 'providers' / 'pi-agent' / 'settings.json').read_text()).get('defaultThinkingLevel')
    config = json.loads(Path(resource['worker_config']).read_text())
    prompt = Path(resource['prompt_file']).read_text()
    worker_settings = json.loads((Path(resource['attempt_dir']) / 'providers' / 'pi-agent' / 'settings.json').read_text())
    out[contract] = {'thinking': worker_settings.get('defaultThinkingLevel'), 'baseDir': resource.get('base_dir') == str(base.resolve()), 'resultContract': config.get('resultContract'), 'attemptKey': config.get('attemptKey'), 'promptHasReportContract': 'REPORT CONTRACT LINE' in prompt, 'promptMentionsReportPath': 'report path' in prompt, 'resourceContract': resource.get('result_contract'), 'readOnly': resource.get('read_only'), 'baseRevision': resource.get('base_revision'), 'attemptKeyMatches': config.get('attemptKey') == resource['acpx_attempt_key']}
print(json.dumps(out))
`, root);
			assert.equal(result.status, 0, result.stderr);
			const out = JSON.parse(result.stdout);
			assert.deepEqual([out["thinking-default"], out["thinking-off"]], [null, "off"], "the route level is written as the worker's default thinking level; without a route level the supervisor default applies");
			assert.deepEqual(out["runtime-v1"], { thinking: "high", baseDir: true, resultContract: "runtime-v1", attemptKey: out["runtime-v1"].attemptKey, promptHasReportContract: false, promptMentionsReportPath: false, resourceContract: "runtime-v1", readOnly: true, baseRevision: null, attemptKeyMatches: true });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("wait settles a runtime worker by retaining its answer before close, then reports post-settlement failures instead of discarding it", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-py-wait-"));
		try {
			const result = python(prelude + `
os.environ['DELEGATE_GRAPH_DB'] = str(root / 'graph.db')
args = core.build_parser().parse_args(['start', str(private), 'searcher', '--node', 'search', '--model', model, '--access-mode', 'read-only'])
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'wait-fixture'}, 'fixture-worker', model, task, 'search')
resource.update({'run_dir': str(private), 'agent': 'fixture-worker', 'role': 'searcher', 'node': 'search', 'tab': None, 'pane': None, 'worker_pid': None})
attempt = Path(resource['attempt_dir'])
output_dir = attempt / 'runtime-output'; output_dir.mkdir(mode=0o700)
(output_dir / 'public-answer.txt').write_text('Retained answer text')
(output_dir / 'public-answer.txt').chmod(0o600)
worker_result = {'schemaVersion': 2, 'resultContract': 'runtime-v1', 'agent': 'codex', 'selectedModel': model, 'sessionName': resource['acpx_session'], 'attemptKey': resource['acpx_attempt_key'], 'outputDir': str(output_dir),
  'output': {'schemaVersion': 1, 'attemptKey': resource['acpx_attempt_key'], 'sessionId': resource['acpx_session'], 'outcome': {'kind': 'exited', 'exitCode': 0},
             'capture': {'requestId': '3', 'sessionId': 'acp-created', 'sessionOrigin': 'created', 'captureStatus': 'complete', 'responseCompleteness': 'unverified', 'inputBytes': 1, 'answerBytes': 20, 'publicChunks': 1, 'ignoredEvents': 0, 'peakBufferedBytes': 1, 'diagnostics': []}, 'stderrTruncated': False}}
Path(resource['worker_result']).write_text(json.dumps(worker_result))
calls = []
core.observe_presentation_identity = lambda r: (calls.append('presentation') or {'presentationVerified': True, 'identityMatches': True, 'transport': 'headless', 'herdrVisible': False})
def failing_close(r):
    calls.append('close')
    raise core.DelegateError('runtime configuration snapshot changed: settings.json')
core.close_acpx_attempt = failing_close
core.abort_acpx_attempt = lambda r, **k: (calls.append('abort') or [])
core.verify_cleanup_absence = lambda run_dir, r, **k: (calls.append('cleanup') or (run_dir / 'cleanup-fixture-worker.json'))
elsewhere = root / 'elsewhere'; elsewhere.mkdir(); os.chdir(elsewhere)
audit = core.settle_runtime_attempt(private, resource)
settle_config = json.loads((attempt / 'runtime-settle.json').read_text())
evidence = json.loads(Path(audit['settlementEvidencePath']).read_text())
content = evidence['candidate']['answer']
content_path = Path(os.environ['DELEGATE_GRAPH_DB']).parent / 'runtime-content' / content['sha256']
print(json.dumps({'settleBaseDir': settle_config['baseDir'] == str(base.resolve()), 'audit': audit, 'calls': calls, 'candidateKind': evidence['candidate']['kind'], 'observation': evidence['observation'], 'retained': content_path.read_text() if content_path.exists() else None, 'outcome': evidence['outcome']}))
`, root);
			assert.equal(result.status, 0, result.stderr);
			const out = JSON.parse(result.stdout);
			assert.deepEqual(out.calls, ["presentation", "close", "abort", "cleanup"]);
			assert.equal(out.settleBaseDir, true, "settlement stages against the dispatch directory, not the caller's current directory");
			assert.equal(out.audit.valid, true);
			assert.equal(out.audit.resultContract, "runtime-v1");
			assert.equal(out.audit.sessionClosed, false);
			assert.equal(out.audit.providerLinksVerified, false);
			assert.match(out.audit.postSettlementFailures[0], /snapshot changed/);
			assert.equal(out.candidateKind, "research");
			assert.equal(out.retained, "Retained answer text");
			assert.deepEqual(out.observation, { sessionId: "acp-created", requestId: "3", sessionOrigin: "created", captureStatus: "complete", manifest: null });
			assert.deepEqual(out.outcome, { kind: "exited", exitCode: 0 });
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("wait settles an owned-write coding attempt from the dispatch resource alone; no legacy export configuration exists", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-py-coding-"));
		try {
			const result = python(prelude + `
import subprocess
os.environ['DELEGATE_GRAPH_DB'] = str(root / 'graph.db')
subprocess.run(['git', 'init', '-q', str(base)], check=True)
(base / 'owned.txt').write_text('before\\n')
subprocess.run(['git', '-C', str(base), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'add', '.'], check=True)
subprocess.run(['git', '-C', str(base), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'base'], check=True)
args = core.build_parser().parse_args(['start', str(private), 'implementer', '--node', 'implement', '--model', model, '--access-mode', 'owned-write', '--owned-paths-json', json.dumps(['owned.txt'])])
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'coding-fixture'}, 'fixture-worker', model, task, 'implement')
resource.update({'run_dir': str(private), 'agent': 'fixture-worker', 'role': 'implementer', 'node': 'implement', 'tab': None, 'pane': None, 'worker_pid': None})
attempt = Path(resource['attempt_dir'])
script = private / 'write.sh'; script.write_text('#!/bin/sh\\nprintf "after\\\\n" > owned.txt\\n'); script.chmod(0o700)
ran = subprocess.run(['agentfs', 'run', '--session', resource['agentfs_session'], '--no-default-allows', '--allow', str(private), str(script)], cwd=str(base), env={**os.environ, 'HOME': resource['agentfs_home']}, capture_output=True, text=True)
assert ran.returncode == 0, ran.stderr
output_dir = attempt / 'runtime-output'; output_dir.mkdir(mode=0o700)
(output_dir / 'public-answer.txt').write_text('Changed owned.txt'); (output_dir / 'public-answer.txt').chmod(0o600)
worker_result = {'schemaVersion': 2, 'resultContract': 'runtime-v1', 'agent': 'codex', 'selectedModel': model, 'sessionName': resource['acpx_session'], 'attemptKey': resource['acpx_attempt_key'], 'outputDir': str(output_dir),
  'output': {'schemaVersion': 1, 'attemptKey': resource['acpx_attempt_key'], 'sessionId': resource['acpx_session'], 'outcome': {'kind': 'exited', 'exitCode': 0},
             'capture': {'requestId': '3', 'sessionId': 'acp-created', 'sessionOrigin': 'created', 'captureStatus': 'complete', 'responseCompleteness': 'unverified', 'inputBytes': 1, 'answerBytes': 17, 'publicChunks': 1, 'ignoredEvents': 0, 'peakBufferedBytes': 1, 'diagnostics': []}, 'stderrTruncated': False}}
Path(resource['worker_result']).write_text(json.dumps(worker_result))
core.observe_presentation_identity = lambda r: {'presentationVerified': True, 'identityMatches': True, 'transport': 'headless', 'herdrVisible': False}
core.close_acpx_attempt = lambda r: {'closed': True}
core.verify_provider_links = lambda *a, **k: True
core.abort_acpx_attempt = lambda r, **k: []
core.verify_cleanup_absence = lambda run_dir, r, **k: (run_dir / 'cleanup-fixture-worker.json')
audit = core.settle_runtime_attempt(private, resource)
evidence = json.loads(Path(audit['settlementEvidencePath']).read_text())
print(json.dumps({'hasExportConfig': 'export_config' in resource, 'snapshot': resource['agentfs_snapshot']['method'], 'snapshotPath': str(resource['agentfs_snapshot']['path']).startswith(str(attempt)),
  'valid': audit['valid'], 'failures': audit.get('postSettlementFailures'), 'kind': evidence['candidate']['kind'], 'artifacts': [(Path(os.environ['DELEGATE_GRAPH_DB']).parent / 'runtime-content' / a['sha256']).read_text(errors='replace') for a in evidence['candidate']['artifacts']],
  'hostUnchanged': (base / 'owned.txt').read_text() == 'before\\n'}))
`, root);
			assert.equal(result.status, 0, result.stderr);
			const out = JSON.parse(result.stdout);
			assert.equal(out.hasExportConfig, false, "the dispatch resource carries no legacy export configuration");
			assert.equal(out.snapshot, "backup");
			assert.equal(out.snapshotPath, true, "the launcher's snapshot lives in the attempt directory and feeds the settle configuration");
			assert.equal(out.valid, true, JSON.stringify(out.failures));
			assert.equal(out.kind, "coding");
			assert.equal(out.hostUnchanged, true, "settlement stages; it never writes the host tree");
			assert.ok(out.artifacts.includes("after\n"), `the owned write is retained as a staged artifact: ${JSON.stringify(out.artifacts)}`);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
