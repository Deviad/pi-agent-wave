import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { buildAgentFsInvocation, expectedAgentFsDb } from "../lib/agentfs-sandbox.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../sqlite.ts";
import { GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { parseRuntimeCandidate } from "../lib/runtime-results.ts";
import { parseRuntimeSettleConfig, settleRuntimeWorker } from "../scripts/runtime-settle.ts";

const scripts = new URL("../scripts", import.meta.url).pathname;
const policy = { input: { kind: "model" as const, model: "openai-codex/gpt-5.6-sol", reason: "test" }, routes: ["searcher", "thinker", "auditor"].map((role) => ({ role, tier: "exact", chain: ["openai-codex/gpt-5.6-sol"], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null })) };
const digest = "a".repeat(64);

function workerResult(root: string, attemptKey: string, answer: string): string {
	const outputDir = join(root, "runtime-output"); mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(outputDir, "public-answer.txt"), answer, { mode: 0o600 });
	const path = join(root, "worker-result.json");
	writeFileSync(path, JSON.stringify({ schemaVersion: 2, resultContract: "runtime-v1", agent: "codex", selectedModel: "openai-codex/gpt-5.6-sol", sessionName: "dg-session", attemptKey, outputDir, output: { schemaVersion: 1, attemptKey, sessionId: "dg-session", outcome: { kind: "exited", exitCode: 0 }, capture: { requestId: "3", sessionId: "acp-fresh", sessionOrigin: "created", captureStatus: "complete", responseCompleteness: "unverified", inputBytes: 10, answerBytes: answer.length, publicChunks: 1, ignoredEvents: 0, peakBufferedBytes: 10, diagnostics: [] }, stderrTruncated: false } }), { mode: 0o600 });
	return path;
}

function command(cwd: string, checkpoint?: string) {
	return [{ id: "linkedin", name: "LinkedIn", command: { executable: "node", args: ["search.mjs"], cwd }, ownedPaths: [join(cwd, "runs", "linkedin")], ...(checkpoint ? { checkpoint } : {}) }];
}

test("operational candidates parse with an observed checkpoint and require an answer", () => {
	const content = { sha256: "b".repeat(64), bytes: 3 };
	const parsed = parseRuntimeCandidate({ kind: "operational", answer: content, artifacts: [content], baseRevision: "none", checkpoint: { path: "runs/linkedin/checkpoint.json", content, jobsSaved: 2, status: "completed" } });
	assert.equal(parsed.kind, "operational");
	if (parsed.kind === "operational") assert.deepEqual(parsed.checkpoint, { path: "runs/linkedin/checkpoint.json", content, jobsSaved: 2, status: "completed" });
	assert.equal(parseRuntimeCandidate({ kind: "operational", answer: content, artifacts: [], baseRevision: "none", checkpoint: null }).kind, "operational");
	assert.throws(() => parseRuntimeCandidate({ kind: "operational", answer: { ...content, bytes: 0 }, artifacts: [], baseRevision: "none", checkpoint: null }), /empty operational candidate/);
	assert.throws(() => parseRuntimeCandidate({ kind: "operational", answer: content, artifacts: [], baseRevision: "none", checkpoint: { path: "x", content, jobsSaved: -1, status: null } }), /jobsSaved/);
});

test("the operations graph initializes on runtime-v1 by default, persists the checkpoint with the command, and refuses a checkpoint outside the owned paths", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ops-init-"));
	const store = new GraphStore({ dbPath: join(root, "graph.db") });
	try {
		const run = store.initRun("ops", "operations", "Run sources", policy as never, command(root, "runs/linkedin/checkpoint.json"));
		assert.equal(store.getRun(run.runId).graph_name, "operations");
		const operation = store.next(run.runId).operations[0];
		assert.equal(operation.node, "source_search");
		assert.equal(operation.read_only, 0);
		assert.deepEqual(JSON.parse(operation.command_json!), { executable: "node", args: ["search.mjs"], cwd: root, checkpoint: "runs/linkedin/checkpoint.json" });
		const plain = store.initRun("ops-plain", "operations", "Run sources", policy as never, command(root));
		assert.deepEqual(JSON.parse(store.next(plain.runId).operations[0].command_json!), { executable: "node", args: ["search.mjs"], cwd: root });
		assert.throws(() => store.initRun("ops-bad", "operations", "Run sources", policy as never, command(root, "elsewhere/checkpoint.json")), /checkpoint must lie under one of its owned paths/);
		assert.throws(() => store.initRun("ops-bad", "operations", "Run sources", policy as never, command(root, "../checkpoint.json")), /checkpoint must lie under one of its owned paths/);
	} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a v9 database with the contract and report columns migrates to v10 without them and accepts an operations run", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ops-migrate-"));
	try {
		const first = new GraphStore({ dbPath: join(root, "graph.db") }); first.close();
		const db = new Database(join(root, "graph.db"));
		try {
			db.exec(`
				ALTER TABLE runs ADD COLUMN result_contract TEXT NOT NULL DEFAULT 'runtime-v1' CHECK(result_contract IN ('legacy-v1','runtime-v1'));
				ALTER TABLE operations ADD COLUMN report_path TEXT;
				CREATE TRIGGER runs_result_contract_immutable
				BEFORE UPDATE OF result_contract ON runs WHEN NEW.result_contract IS NOT OLD.result_contract
				BEGIN SELECT RAISE(ABORT, 'result contract is immutable'); END;
				CREATE TRIGGER runs_result_contract_graph
				BEFORE INSERT ON runs WHEN NEW.result_contract='runtime-v1' AND NEW.graph_name NOT IN ('build','research')
				BEGIN SELECT RAISE(ABORT, 'unsupported graph result contract'); END;
				DELETE FROM schema_version WHERE version IN (9, 10, 11);
			`);
			assert.equal(db.query<{ version: number }>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 8);
		} finally { db.close(); }
		const store = new GraphStore({ dbPath: join(root, "graph.db") });
		try {
			const check = new Database(join(root, "graph.db"));
			try {
				assert.equal(check.query<{ version: number }>("SELECT MAX(version) AS version FROM schema_version").get()?.version, 11);
				assert.equal(check.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('runs_result_contract_graph','runs_result_contract_immutable')").get(), undefined);
				assert.deepEqual(check.query<{ name: string }>("PRAGMA table_info(runs)").all().map((column) => column.name).filter((name) => name === "result_contract"), []);
				assert.deepEqual(check.query<{ name: string }>("PRAGMA table_info(operations)").all().map((column) => column.name).filter((name) => name === "report_path"), []);
				assert.ok(check.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='runtime_attempts_identity_insert'").get(), "the attempt identity trigger is recreated without the contract clause");
			} finally { check.close(); }
			const run = store.initRun("ops", "operations", "Run sources", policy as never, command(root));
			assert.equal(store.getRun(run.runId).graph_name, "operations");
		} finally { store.close(); }
		// Every later open runs the idempotent v6 repair; it must not resurrect the trigger (the first live operations smoke failed exactly so).
		const again = new GraphStore({ dbPath: join(root, "graph.db") });
		try {
			const recheck = new Database(join(root, "graph.db"));
			try { assert.equal(recheck.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name='runs_result_contract_graph'").get(), undefined); } finally { recheck.close(); }
			assert.equal(again.getRun(again.initRun("ops-again", "operations", "Run sources", policy as never, command(root)).runId).graph_name, "operations");
		} finally { again.close(); }
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const verdict of ["DONE", "BLOCKED"] as const) test(`operational settlement stages the owned artifacts of a non-Git workspace, observes the checkpoint, integrates without Git, and ${verdict} ${verdict === "DONE" ? "advances to synthesis" : "parks the run blocked"}`, () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ops-settle-"));
	const stores: GraphStore[] = [];
	try {
		const base = join(root, "base"); mkdirSync(join(base, "runs", "linkedin"), { recursive: true });
		writeFileSync(join(base, "search.mjs"), "// fixture source script\n");
		const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		const store = new GraphStore({ dbPath: join(home, "graph.db") }); stores.push(store);
		const run = store.initRun("ops", "operations", "Run sources", policy as never, command(base, "runs/linkedin/checkpoint.json"), "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "searcher", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-session", requestId: null, policyDigest: store.policy(run.runId).digest });
		// The source script runs inside a mounted AgentFS session, exactly as a worker's command would, and writes its checkpoint and results.
		const privateDir = join(root, "private"); mkdirSync(privateDir, { mode: 0o700 });
		const script = join(privateDir, "source.sh");
		writeFileSync(script, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ jobsSaved: 2, status: "completed", runId: "linkedin-1" })}' > runs/linkedin/checkpoint.json\nprintf '%s' '[{"id":1},{"id":2}]' > runs/linkedin/results.json\n`, { mode: 0o700 }); chmodSync(script, 0o700);
		const invocation = buildAgentFsInvocation({ sessionId: "candidate", baseDir: base, homeDir: home, privateDir, command: script, args: [] }, env);
		const ran = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
		assert.equal(ran.status, 0, ran.stderr);
		const source = expectedAgentFsDb(home, "candidate"); const snapshotPath = join(root, "closed.db");
		execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", source, snapshotPath]);
		const answer = `Ran node search.mjs; two candidates saved.\n\nVERDICT: ${verdict}\n`;
		const evidence = settleRuntimeWorker(parseRuntimeSettleConfig({ schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(root, identity.attemptKey, answer), kind: "operational", baseDir: base, baseRevision: "none", checkpointPath: join(base, "runs", "linkedin", "checkpoint.json"), ownedPaths: [join(base, "runs", "linkedin")], readOnly: false, snapshotPath, agentFsExecutable: "agentfs", evidencePath: join(root, "runtime-settlement.json"), dbPath: join(home, "graph.db") }));
		assert.equal(evidence.candidate?.kind, "operational");
		// macOS may add AppleDouble `._*` companions inside the owned directory; they stage with it and are harmless.
		assert.ok(evidence.stagedFiles >= 2, `staged ${evidence.stagedFiles}`);
		if (evidence.candidate?.kind !== "operational") throw new Error("unreachable");
		assert.equal(evidence.candidate.baseRevision, "none");
		assert.deepEqual({ path: evidence.candidate.checkpoint?.path, jobsSaved: evidence.candidate.checkpoint?.jobsSaved, status: evidence.candidate.checkpoint?.status }, { path: "runs/linkedin/checkpoint.json", jobsSaved: 2, status: "completed" });
		rmSync(snapshotPath);
		const attempt = store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: evidence.outcome, candidate: evidence.candidate, observation: evidence.observation });
		assert.equal(attempt.acceptance, "pending");
		assert.throws(() => store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "source ran", verdict }), /operational acceptance requires an applied integration/);
		assert.equal(existsSync(join(base, "runs", "linkedin", "checkpoint.json")), false);
		const applied = store.applyRuntimeIntegration(identity.attemptKey, evidence.observation.manifest!);
		assert.equal(applied.state, "applied");
		assert.deepEqual(JSON.parse(readFileSync(join(base, "runs", "linkedin", "checkpoint.json"), "utf8")), { jobsSaved: 2, status: "completed", runId: "linkedin-1" });
		assert.equal(readFileSync(join(base, "runs", "linkedin", "results.json"), "utf8"), "[{\"id\":1},{\"id\":2}]");
		assert.equal(spawnSync("git", ["-C", base, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status !== 0 || existsSync(join(base, ".git")) === false, true, "the workspace is not a Git repository");
		const decided = store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "checkpoint observed and results placed", verdict });
		assert.equal(decided.attempt.decision?.integrationId, applied.id);
		assert.equal(store.getOperation(operation.id).status, "completed");
		const state = store.getState(run.runId);
		if (verdict === "DONE") { assert.equal(state.status, "active"); assert.equal(state.currentNode, "thinker_synthesize"); }
		else { assert.equal(state.status, "blocked"); assert.equal(state.currentNode, "source_search"); }
		const ledger = store.runtimeLedger(run.runId);
		const entry = ledger.operations.find((item) => item.node === "source_search")!.attempts[0];
		assert.equal(entry.candidateKind, "operational");
		assert.deepEqual({ jobsSaved: entry.checkpoint?.jobsSaved, status: entry.checkpoint?.status }, { jobsSaved: 2, status: "completed" });
	} finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("the Python launcher records the checkpoint path from the operational command and settles source_search as operational", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ops-python-"));
	try {
		const result = spawnSync("python3", ["-c", `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
core.ACTIVE_TRANSPORT = 'headless'
root = Path(sys.argv[2])
home = root / 'home'; (home / '.codex').mkdir(parents=True)
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
os.environ['HOME'] = str(home); os.environ['CODEX_HOME'] = str(home / '.codex'); os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
base = root / 'base'; (base / 'runs' / 'linkedin').mkdir(parents=True); private = root / 'private'; private.mkdir(mode=0o700)
os.chdir(base)
model = 'openai-codex/gpt-5.6-sol'
task = private / 'task.md'; task.write_text('Run the source.'); task.chmod(0o600)
command = json.dumps({'executable': 'node', 'args': ['search.mjs'], 'cwd': str(base), 'checkpoint': 'runs/linkedin/checkpoint.json'})
args = core.build_parser().parse_args(['start', str(private), 'searcher', '--node', 'source_search', '--model', model, '--owned-paths-json', json.dumps([str(base / 'runs' / 'linkedin')]), '--command-json', command])
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'ops-fixture'}, 'fixture-worker', model, task, 'source_search')
prompt = Path(resource['prompt_file']).read_text()
try:
    core.operational_instruction(json.dumps({'executable': 'node', 'args': [], 'cwd': str(root / 'elsewhere')}), base)
    foreign = 'accepted'
except core.DelegateError as error:
    foreign = str(error)
print(json.dumps({'checkpointPath': resource.get('checkpoint_path'), 'readOnly': resource.get('read_only'), 'baseRevision': resource.get('base_revision'), 'promptHasArgv': '"node", "search.mjs"' in prompt or '["node", "search.mjs"]' in prompt, 'promptHasVerdict': 'VERDICT: <value>' in prompt and 'DONE, BLOCKED' in prompt, 'noReport': 'No report file is required' in prompt, 'promptCwdDot': 'cwd: "."' in prompt and str(base) not in prompt.split('Operational command contract')[1], 'foreignCwd': foreign}))
`, scripts, root], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		assert.equal(result.status, 0, result.stderr);
		const out = JSON.parse(result.stdout);
		assert.deepEqual(out, { checkpointPath: join(realpathSync(root), "base", "runs", "linkedin", "checkpoint.json"), readOnly: false, baseRevision: null, promptHasArgv: true, promptHasVerdict: true, noReport: true, promptCwdDot: true, foreignCwd: "operational command cwd must be the worker working directory" });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a checkpoint that appears on the host without an overlay change fails settlement instead of passing as audited work", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-ops-bypass-"));
	const stores: GraphStore[] = [];
	try {
		const base = join(root, "base"); mkdirSync(join(base, "runs", "linkedin"), { recursive: true });
		const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		const store = new GraphStore({ dbPath: join(home, "graph.db") }); stores.push(store);
		const run = store.initRun("ops", "operations", "Run sources", policy as never, command(base, "runs/linkedin/checkpoint.json"), "runtime-v1");
		const operation = store.next(run.runId).operations[0];
		const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "searcher", modelAttempt: 0, transientAttempt: 0, selectedModel: "openai-codex/gpt-5.6-sol", agent: "codex" });
		store.beginRuntimeAttempt({ identity, sessionId: "dg-session", requestId: null, policyDigest: store.policy(run.runId).digest });
		const privateDir = join(root, "private"); mkdirSync(privateDir, { mode: 0o700 });
		const script = join(privateDir, "source.sh"); writeFileSync(script, "#!/bin/sh\ntrue\n", { mode: 0o700 }); chmodSync(script, 0o700);
		const invocation = buildAgentFsInvocation({ sessionId: "bypass", baseDir: base, homeDir: home, privateDir, command: script, args: [] }, env);
		const ran = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
		assert.equal(ran.status, 0, ran.stderr);
		// The "worker" wrote the checkpoint straight to the host, as a process using an absolute host path does.
		writeFileSync(join(base, "runs", "linkedin", "checkpoint.json"), JSON.stringify({ jobsSaved: 1, status: "completed" }));
		const source = expectedAgentFsDb(home, "bypass"); const snapshotPath = join(root, "closed.db");
		execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", source, snapshotPath]);
		assert.throws(() => settleRuntimeWorker(parseRuntimeSettleConfig({ schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(root, identity.attemptKey, "Ran it.\n\nVERDICT: DONE\n"), kind: "operational", baseDir: base, baseRevision: "none", checkpointPath: join(base, "runs", "linkedin", "checkpoint.json"), ownedPaths: [join(base, "runs", "linkedin")], readOnly: false, snapshotPath, agentFsExecutable: "agentfs", evidencePath: join(root, "runtime-settlement.json"), dbPath: join(home, "graph.db") })), /exists on the host but was not written through the sandbox overlay/);
		assert.equal(existsSync(join(root, "runtime-settlement.json")), false);
	} finally { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); }
});
