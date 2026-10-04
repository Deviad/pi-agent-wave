import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentFsInvocation, expectedAgentFsDb } from "../lib/agentfs-sandbox.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { RuntimeIntegration } from "../lib/runtime-integration.ts";
import { parseRuntimeStagingManifest, stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { Database } from "../sqlite.ts";
import { CURRENT_SCHEMA_VERSION, GraphStore } from "../store.ts";
import { createHeadlessAcpxAttemptIdentity } from "../lib/acpx-types.ts";
import { parseRuntimeSettleConfig, settleRuntimeWorker } from "../scripts/runtime-settle.ts";
import { readdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectAcpAgent } from "../lib/acpx-select.ts";
import { renderStatus } from "../commands.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

/** A non-Git directory standing in for `$HOME`, with a private graph home beside it. */
function placementFixture() {
	const root = scratch("home-placement-");
	const workspace = join(root, "home");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "existing.txt"), "before");
	const graphHome = join(root, "graph");
	mkdirSync(graphHome, { mode: 0o700 });
	const dbPath = join(graphHome, "graph.db");
	return { workspace, content: new RuntimeContentStore(dbPath), journal: new RuntimeIntegration(dbPath) };
}

describe("placement without Git checks", () => {
	test("creates missing parent directories, and rollback removes the file it created", () => {
		const { workspace, content, journal } = placementFixture();
		try {
			const changes = [{ path: ".config/newapp/config.toml", after: content.retain(Buffer.from("key = 1\n")), mode: 0o644 }];
			const prepared = journal.prepare({ workspace, baseRevision: "none", candidateId: "home-new-dir", ownedPaths: [".config/newapp/config.toml"], changes, gitChecks: false });
			assert.equal(existsSync(join(workspace, ".config")), false, "prepare writes nothing");
			assert.equal(journal.apply(prepared.id).state, "applied");
			assert.equal(readFileSync(join(workspace, ".config/newapp/config.toml"), "utf8"), "key = 1\n");
			assert.throws(() => journal.rollback(prepared.id), /integration is applied/, "rollback stays a recovery verb for unfinished integrations");
			assert.equal(journal.undo(prepared.id).state, "rolled_back");
			assert.equal(existsSync(join(workspace, ".config/newapp/config.toml")), false);
		} finally { journal.close(); }
	});

	test("places a file inside a nested repository and restores its preimage on rollback", () => {
		const { workspace, content, journal } = placementFixture();
		try {
			mkdirSync(join(workspace, ".pi", "agent"), { recursive: true });
			execFileSync("git", ["init", "-q", join(workspace, ".pi", "agent")]);
			writeFileSync(join(workspace, ".pi/agent/settings.json"), "{\"old\":true}\n");
			const changes = [{ path: ".pi/agent/settings.json", after: content.retain(Buffer.from("{\"new\":true}\n")), mode: 0o644 }];
			const prepared = journal.prepare({ workspace, baseRevision: "none", candidateId: "home-nested", ownedPaths: [".pi/agent/settings.json"], changes, gitChecks: false });
			assert.equal(journal.apply(prepared.id).state, "applied");
			assert.equal(readFileSync(join(workspace, ".pi/agent/settings.json"), "utf8"), "{\"new\":true}\n");
			assert.equal(journal.undo(prepared.id).state, "rolled_back");
			assert.equal(readFileSync(join(workspace, ".pi/agent/settings.json"), "utf8"), "{\"old\":true}\n");
		} finally { journal.close(); }
	});

	test("undo of a placement whose file was edited afterwards stops in needs_reconciliation and keeps the edit", () => {
		const { workspace, content, journal } = placementFixture();
		try {
			const changes = [
				{ path: "existing.txt", after: content.retain(Buffer.from("placed")), mode: 0o644 },
				{ path: "other.txt", after: content.retain(Buffer.from("new file")), mode: 0o644 },
			];
			const prepared = journal.prepare({ workspace, baseRevision: "none", candidateId: "home-edited", ownedPaths: ["existing.txt", "other.txt"], changes, gitChecks: false });
			assert.equal(journal.apply(prepared.id).state, "applied");
			writeFileSync(join(workspace, "existing.txt"), "operator edit");
			assert.throws(() => journal.undo(prepared.id), /conflict at existing.txt/);
			assert.equal(journal.get(prepared.id).state, "needs_reconciliation");
			assert.equal(readFileSync(join(workspace, "existing.txt"), "utf8"), "operator edit");
			assert.equal(readFileSync(join(workspace, "other.txt"), "utf8"), "new file", "nothing is overwritten once a conflict is found");
		} finally { journal.close(); }
	});

	test("undo is refused while another integration of the workspace is active", () => {
		const { workspace, content, journal } = placementFixture();
		try {
			const first = journal.prepare({ workspace, baseRevision: "none", candidateId: "home-first", ownedPaths: ["a.txt"], changes: [{ path: "a.txt", after: content.retain(Buffer.from("a")), mode: 0o644 }], gitChecks: false });
			assert.equal(journal.apply(first.id).state, "applied");
			const second = journal.prepare({ workspace, baseRevision: "none", candidateId: "home-second", ownedPaths: ["b.txt"], changes: [{ path: "b.txt", after: content.retain(Buffer.from("b")), mode: 0o644 }], gitChecks: false });
			assert.equal(second.state, "prepared");
			assert.throws(() => journal.undo(first.id), /active integration/);
			assert.equal(journal.get(first.id).state, "applied");
		} finally { journal.close(); }
	});

	test("with Git checks a new directory is allowed and the nested-repository refusal stands", () => {
		const root = scratch("home-placement-git-");
		const workspace = join(root, "repo");
		mkdirSync(workspace);
		execFileSync("git", ["init", "-q", workspace]);
		writeFileSync(join(workspace, "a.txt"), "a");
		mkdirSync(join(workspace, "vendor", "lib"), { recursive: true });
		execFileSync("git", ["init", "-q", join(workspace, "vendor", "lib")]);
		writeFileSync(join(workspace, "vendor/lib/x.txt"), "x");
		execFileSync("git", ["-C", workspace, "add", "a.txt"]);
		execFileSync("git", ["-C", workspace, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
		const baseRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const graphHome = join(root, "graph");
		mkdirSync(graphHome, { mode: 0o700 });
		const dbPath = join(graphHome, "graph.db");
		const content = new RuntimeContentStore(dbPath);
		const journal = new RuntimeIntegration(dbPath);
		try {
			const after = content.retain(Buffer.from("y"));
			const newDir = journal.prepare({ workspace, baseRevision, candidateId: "git-new-dir", ownedPaths: ["src"], changes: [{ path: "src/new/file.ts", after, mode: 0o644 }] });
			assert.equal(journal.rollback(newDir.id).state, "rolled_back");
			assert.throws(() => journal.prepare({ workspace, baseRevision, candidateId: "git-nested", ownedPaths: ["vendor"], changes: [{ path: "vendor/lib/x.txt", after, mode: 0o644 }] }), /nested repository/);
			const applied = journal.prepare({ workspace, baseRevision, candidateId: "git-applied", ownedPaths: ["a.txt"], changes: [{ path: "a.txt", after, mode: 0o644 }] });
			assert.equal(journal.apply(applied.id).state, "applied");
			assert.throws(() => journal.undo(applied.id), /Git checks/);
			assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "y");
		} finally { journal.close(); }
	});
});

/** The sqlite backup plus DELETE journal that scripts/delegate_core.py takes, so the snapshot is self-contained. */
function snapshotAgentFsDb(dbPath: string, snapshotPath: string): void {
	rmSync(snapshotPath, { force: true });
	execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", dbPath, snapshotPath]);
}

/** Runs `body` as a worker inside a real mounted AgentFS session rooted at `base`; returns the delta path. */
function mountedWorker(root: string, base: string, sessionId: string, body: string): string {
	const home = join(root, `home-${sessionId}`);
	const privateDir = join(root, `private-${sessionId}`);
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(privateDir, { mode: 0o700 });
	const script = join(privateDir, "worker.sh");
	writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	const invocation = buildAgentFsInvocation({ sessionId, baseDir: base, homeDir: home, privateDir, command: script, args: [] }, { ...process.env, AGENTFS_HOME: home });
	const run = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
	assert.equal(run.status, 0, run.stderr);
	return expectedAgentFsDb(home, sessionId);
}

describe("staging a home workspace", () => {
	test("owns every changed path except .git internals and the graph home, and lists them as owned", () => {
		const root = scratch("home-staging-");
		const base = join(root, "home");
		mkdirSync(join(base, "repo", ".git"), { recursive: true });
		mkdirSync(join(base, "graph"), { recursive: true });
		writeFileSync(join(base, "existing.txt"), "before");
		const dbPath = mountedWorker(root, base, "home-stage", [
			"printf top > top.txt",
			"printf edited > existing.txt",
			"mkdir -p .config/newapp && printf 'key = 1' > .config/newapp/config.toml",
			"printf ref > repo/.git/ORIG_HEAD",
			"printf store > graph/delegate-graph.db",
		].join("\n"));
		const snapshot = join(root, "snapshot.db");
		snapshotAgentFsDb(dbPath, snapshot);
		const graphHome = join(root, "graph-home");
		mkdirSync(graphHome, { mode: 0o700 });
		const content = new RuntimeContentStore(join(graphHome, "graph.db"));
		const input = { agentFsExecutable: "agentfs", snapshotPath: snapshot, baseDir: base, baseRevision: "none", attemptKey: "home-stage-attempt", ownedPaths: [base], readOnly: false };
		assert.throws(() => stageRuntimeAgentFs(input, content), /whole base/, "a repository run still refuses whole-base ownership");
		const staged = stageRuntimeAgentFs({ ...input, ownWholeBase: true, excludedRoots: [join(base, "graph")] }, content);
		const paths = staged.changes.map((change) => change.path).sort();
		assert.deepEqual(paths, [".config/newapp/config.toml", "existing.txt", "top.txt"]);
		const manifest = parseRuntimeStagingManifest(JSON.parse(content.read(staged.manifest, 1024 * 1024).toString("utf8")));
		assert.deepEqual([...manifest.ownedPaths].sort(), paths);
		assert.equal(readFileSync(join(base, "existing.txt"), "utf8"), "before", "staging never writes the host");
	});
});

/** Runs `body` with `HOME` pointing at a temporary directory, restoring it afterwards. */
function withHome<T>(body: (home: string) => T): T {
	const home = realpathSync(scratch("home-root-"));
	const saved = process.env.HOME;
	process.env.HOME = home;
	try { return body(home); } finally { process.env.HOME = saved; }
}

describe("store: the run's workspace root", () => {
	test("a v12 store reopens at v13 with workspace_root added and every existing row unchanged", () => {
		const root = scratch("home-v13-");
		const dbPath = join(root, "graph.db");
		const store = new GraphStore({ dbPath });
		const run = store.initRun("seeded-v12", "build", "Plan the change");
		store.close();
		const seeded = new Database(dbPath);
		seeded.exec("ALTER TABLE runs DROP COLUMN workspace_root; DELETE FROM schema_version WHERE version > 12;");
		const before = seeded.query<Record<string, unknown>, []>("SELECT * FROM runs ORDER BY rowid").all();
		seeded.close();
		const migrated = new GraphStore({ dbPath });
		assert.equal(migrated.getRun(run.runId).workspace_root, null);
		migrated.close();
		const check = new Database(dbPath, { readonly: true });
		try {
			assert.equal(check.query<{ version: number }, []>("SELECT MAX(version) AS version FROM schema_version").get()?.version, CURRENT_SCHEMA_VERSION);
			const after = check.query<Record<string, unknown>, []>(`SELECT ${Object.keys(before[0]!).join(",")} FROM runs ORDER BY rowid`).all();
			assert.deepEqual(after, before);
		} finally { check.close(); }
	});

	test("initRun records a root inside HOME and refuses anything else", () => withHome((home) => {
		const root = scratch("home-init-");
		const store = new GraphStore({ dbPath: join(root, "graph.db") });
		try {
			mkdirSync(join(home, ".config"));
			assert.equal(store.getRun(store.initRun("home", "build", "Edit config", undefined, undefined, { workspaceRoot: home }).runId).workspace_root, home);
			assert.equal(store.getRun(store.initRun("sub", "research", "Read config", undefined, undefined, { workspaceRoot: join(home, ".config") }).runId).workspace_root, join(home, ".config"));
			assert.equal(store.getRun(store.initRun("plain", "build", "Normal run").runId).workspace_root, null);
			assert.throws(() => store.initRun("outside", "build", "x", undefined, undefined, { workspaceRoot: root }), /under HOME/);
			assert.throws(() => store.initRun("missing", "build", "x", undefined, undefined, { workspaceRoot: join(home, "absent") }), /existing directory/);
			assert.throws(() => store.initRun("ops", "operations", "x", undefined, [{ id: "c", name: "c", command: { executable: "true", args: [], cwd: home }, ownedPaths: ["out"] }], { workspaceRoot: home }), /build or research/);
		} finally { store.close(); }
	}));
});

const MODEL = "openai-codex/gpt-5.6-sol";
const POLICY = { input: { kind: "model" as const, model: MODEL, reason: "test" }, routes: [{ role: "thinker", tier: "exact", chain: [MODEL], thinking: "high", session: true, capabilityFloor: "planning", selectionSource: "model", promoted: false, promotionReason: null }] };

/** A schema-2 worker result, as scripts/acpx-worker.ts writes it, carrying `answer` as the public reply. */
function workerResult(dir: string, attemptKey: string, answer: string): string {
	const outputDir = join(dir, "runtime-output");
	mkdirSync(outputDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(outputDir, "public-answer.txt"), answer, { mode: 0o600 });
	const path = join(dir, "worker-result.json");
	writeFileSync(path, JSON.stringify({ schemaVersion: 2, resultContract: "runtime-v1", agent: "codex", selectedModel: MODEL, sessionName: "dg-session", attemptKey, outputDir, output: { schemaVersion: 1, attemptKey, sessionId: "dg-session", outcome: { kind: "exited", exitCode: 0 }, capture: { requestId: "1", sessionId: "acp", sessionOrigin: "created", captureStatus: "complete", responseCompleteness: "unverified", inputBytes: 1, answerBytes: answer.length, publicChunks: 1, ignoredEvents: 0, peakBufferedBytes: 1, diagnostics: [] }, stderrTruncated: false } }), { mode: 0o600 });
	return path;
}

function allFiles(dir: string, prefix = ""): string[] {
	return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? allFiles(dir, join(prefix, entry.name)) : [join(prefix, entry.name)]);
}

describe("end to end: a home run places changes and undoes them after the run ended", () => {
	test("settle with whole-base ownership, integrate without Git checks, end the run, then undo", () => withHome((home) => {
		const root = scratch("home-e2e-");
		writeFileSync(join(home, "existing.txt"), "before");
		const graphHome = join(root, "graph");
		mkdirSync(graphHome, { mode: 0o700 });
		const store = new GraphStore({ dbPath: join(graphHome, "graph.db") });
		try {
			const run = store.initRun("home-e2e", "build", "Edit configuration", POLICY as never, undefined, { workspaceRoot: home });
			const operation = store.next(run.runId).operations[0]!;
			assert.ok(renderStatus(store, run.runId).split("\n")[0]!.endsWith(` | workspace=home:${home}`), "status names the home root");
			const identity = createHeadlessAcpxAttemptIdentity({ runId: run.runId, operationId: operation.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: MODEL, agent: "codex" });
			store.beginRuntimeAttempt({ identity, sessionId: "dg-session", requestId: null, policyDigest: store.policy(run.runId).digest });
			const delta = mountedWorker(root, home, "home-e2e", "printf edited > existing.txt\nmkdir -p .config/newapp && printf 'key = 1' > .config/newapp/config.toml");
			const snapshotPath = join(root, "snapshot.db");
			snapshotAgentFsDb(delta, snapshotPath);
			const attemptDir = join(root, "attempt");
			mkdirSync(attemptDir, { mode: 0o700 });
			const evidence = settleRuntimeWorker(parseRuntimeSettleConfig({
				schemaVersion: 1, attemptKey: identity.attemptKey, workerResultPath: workerResult(attemptDir, identity.attemptKey, "Configured newapp."), kind: "coding",
				baseDir: home, baseRevision: "none", checkpointPath: null, ownedPaths: [home], readOnly: false, snapshotPath, agentFsExecutable: "agentfs",
				evidencePath: join(attemptDir, "runtime-settlement.json"), dbPath: store.dbPath, ownWholeBase: true,
			}));
			assert.equal(evidence.candidate?.kind, "coding");
			store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: evidence.outcome, candidate: evidence.candidate ?? undefined, observation: evidence.observation });
			const manifest = evidence.observation.manifest!;

			assert.equal(store.applyRuntimeIntegration(identity.attemptKey, manifest, "apply").state, "applied");
			assert.equal(readFileSync(join(home, "existing.txt"), "utf8"), "edited");
			assert.equal(readFileSync(join(home, ".config/newapp/config.toml"), "utf8"), "key = 1");
			assert.deepEqual(allFiles(home).filter((path) => path.split("/").some((part) => part.startsWith("._"))), [], "no AppleDouble sidecar is placed");

			store.cancelRunningOperations(run.runId, "the operator ended the run");
			assert.equal(store.getRun(run.runId).status, "cancelled");
			const undone = store.applyRuntimeIntegration(identity.attemptKey, manifest, "rollback");
			assert.equal(undone.state, "rolled_back");
			assert.equal(readFileSync(join(home, "existing.txt"), "utf8"), "before");
			assert.equal(existsSync(join(home, ".config/newapp/config.toml")), false);
			assert.ok(store.events(run.runId, 200).some((event) => event.type === "integration_undone"), "the undo is recorded");
		} finally { store.close(); }
	}));
});

/**
 * Runs prepare_acpx_attempt offline (no model is dispatched) and returns the resource, the prompt and the
 * runtime-settle configuration the launcher would write for a coding settlement.
 */
function prepareLauncher(workspace: string, extraArgv: readonly string[]): { resource: Record<string, unknown>; prompt: string; settle: Record<string, unknown> | { error: string } } {
	const privateDir = join(scratch("home-launcher-"), "private");
	mkdirSync(privateDir, { mode: 0o700 });
	const script = `
import json, os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
core.ACTIVE_TRANSPORT = 'headless'
base, private = Path(sys.argv[2]), Path(sys.argv[3])
home = private / 'provider-home'
(home / '.codex').mkdir(parents=True)
(home / '.codex' / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'offline-fixture-not-a-credential'}))
os.environ['HOME'] = str(home)
os.environ['CODEX_HOME'] = str(home / '.codex')
os.environ.pop('PI_CLAUDE_OAUTH_TOKEN_FILE', None)
os.chdir(base)
model = 'openai-codex/gpt-5.6-sol'
argv = ['start', str(private), 'implementer', '--node', 'implement', '--model', model, '--access-mode', 'owned-write', '--owned-paths-json', json.dumps(['.'] if '--workspace-mode' in sys.argv[4] else ['owned.txt'])]
argv += json.loads(sys.argv[4])
args = core.build_parser().parse_args(argv)
task = private / 'task.md'
task.write_text('Offline preparation fixture; do not dispatch a model.')
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'home-fixture'}, 'fixture-worker', model, task, 'implement')
try:
    settle = core.runtime_settle_config(resource, 'coding', private / 'snapshot.db', private / 'evidence.json')
except core.DelegateError as error:
    settle = {'error': str(error)}
print(json.dumps({'resource': {k: resource.get(k) for k in ('workspace_mode', 'base_revision', 'owned_paths', 'base_dir')}, 'prompt': Path(resource['prompt_file']).read_text(), 'settle': settle}))
`;
	const result = spawnSync("python3", ["-c", script, new URL("../scripts", import.meta.url).pathname, workspace, privateDir, JSON.stringify(extraArgv)], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("launcher: workspace mode", () => {
	test("home mode records the mode, instructs the worker, and settles with whole-base ownership and no Git base", () => {
		const workspace = realpathSync(scratch("home-launcher-ws-"));
		const prepared = prepareLauncher(workspace, ["--workspace-mode", "home"]);
		assert.equal(prepared.resource.workspace_mode, "home");
		assert.equal(prepared.resource.base_revision, null);
		assert.deepEqual(prepared.resource.owned_paths, [workspace]);
		assert.match(prepared.prompt, /working directory is the operator's home workspace/);
		assert.match(prepared.prompt, /relative to the current directory/);
		assert.match(prepared.prompt, /do not commit/i);
		assert.ok(!("error" in prepared.settle), JSON.stringify(prepared.settle));
		const settle = prepared.settle as Record<string, unknown>;
		assert.equal(settle.ownWholeBase, true);
		assert.equal(settle.baseRevision, "none");
		assert.equal(settle.kind, "coding");
	});

	test("repository mode is unchanged: no home instruction, no whole-base ownership, Git base required", () => {
		const workspace = realpathSync(scratch("home-launcher-repo-"));
		writeFileSync(join(workspace, "owned.txt"), "x");
		const prepared = prepareLauncher(workspace, []);
		assert.equal(prepared.resource.workspace_mode, "repository");
		assert.doesNotMatch(prepared.prompt, /home workspace/);
		assert.match(JSON.stringify(prepared.settle), /requires a Git base revision/);
	});
});

// A route with no credential anywhere: a dispatch that passes every precondition stops at the worker
// preflight, which is how the launch arguments are observed without spending a model.
const DEAD_ROUTE = "nosuchproviderxyz/dead-route";

describe("dispatch of a home run", () => {
	test("launches from the workspace root, skips the Git precondition, and passes home mode with whole-base ownership", async () => {
		const root = scratch("home-dispatch-");
		const home = realpathSync(scratch("home-dispatch-home-"));
		const sessionDir = join(root, "elsewhere");
		mkdirSync(sessionDir);
		const saved = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, db: process.env.DELEGATE_GRAPH_DB, herdr: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID };
		try {
			process.env.HOME = home;
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			process.env.DELEGATE_GRAPH_DB = join(root, "graph", "graph.db");
			delete process.env.HERDR_ENV; delete process.env.HERDR_WORKSPACE_ID; delete process.env.HERDR_TAB_ID;
			mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
			mkdirSync(join(root, "graph"), { mode: 0o700 });
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "model-routing.jsonc"), JSON.stringify({
				default_tier: "tools",
				tiers: { tools: { models: [DEAD_ROUTE], thinking: "off", session: true } },
				roles: Object.fromEntries(["thinker", "implementer", "reviewer", "tester", "auditor", "searcher"].map((role) => [role, { tier: "tools" }])),
			}));
			writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {} }));
			const invocations: { command: string; args: string[]; cwd?: string }[] = [];
			const { default: extension } = await import(`../index.ts?home-dispatch=${Date.now()}`);
			let tool: Record<string, any> = {};
			extension({
				registerCommand() {}, on() {}, sendUserMessage() {},
				registerTool(definition: Record<string, any>) { tool = definition; },
				exec: async (command: string, args: string[], options?: { cwd?: string }) => {
					invocations.push({ command, args: [...args], cwd: options?.cwd });
					const result = spawnSync(command, args, { encoding: "utf8", cwd: options?.cwd });
					return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", killed: false };
				},
			} as unknown as ExtensionAPI);
			const call = async (params: Record<string, unknown>) => JSON.parse((await tool.execute("call", params, undefined, () => {}, { cwd: sessionDir } as ExtensionContext)).content[0].text);

			const init = await call({ op: "init", story: "home-dispatch", graph: "build", task: "Edit configuration", workspaceRoot: "~" });
			assert.equal(init.error, undefined, JSON.stringify(init));
			const runId: string = init.state.runId;
			const store = new GraphStore({ dbPath: process.env.DELEGATE_GRAPH_DB });
			let operationId: string;
			try {
				assert.equal(store.getRun(runId).workspace_root, home, "~ resolves to the real HOME");
				const plan = store.next(runId).operations[0]!;
				const identity = createHeadlessAcpxAttemptIdentity({ runId, operationId: plan.id, role: "thinker", modelAttempt: 0, transientAttempt: 0, selectedModel: DEAD_ROUTE, agent: selectAcpAgent(DEAD_ROUTE) });
				store.beginRuntimeAttempt({ identity, sessionId: "dg-plan", requestId: null, policyDigest: store.policy(runId).digest });
				const answer = new RuntimeContentStore(store.dbPath).retain(Buffer.from("# Plan\n\nOne slice.\n"));
				store.settleRuntimeAttempt({ attemptKey: identity.attemptKey, outcome: { kind: "exited", exitCode: 0 }, candidate: { kind: "research", answer, sources: [] }, observation: { sessionId: "acp-1", requestId: "1", sessionOrigin: "created", captureStatus: "complete", manifest: null } });
				store.decideRuntimeCandidate({ attemptKey: identity.attemptKey, decision: "accepted", reason: "plan accepted", verdict: "READY", payload: { slices: [{ id: "cfg", name: "cfg", task: "Write the config", ownedPaths: [".config/app/config.toml"] }] } });
				operationId = store.next(runId).operations.find((operation) => operation.node === "implement")!.id;
			} finally { store.close(); }

			invocations.length = 0;
			const dispatched = await call({ op: "dispatch", runId, operationId, transport: "headless" });
			assert.notEqual(dispatched.blocked, "precondition", `a home run is not refused for missing Git: ${JSON.stringify(dispatched)}`);
			assert.equal(invocations.some((item) => item.command === "git" && item.args.includes("--verify")), false, "no Git precondition probe");
			const start = invocations.find((item) => item.args.includes("start"));
			assert.ok(start, `the launcher was started: ${JSON.stringify(invocations.map((item) => item.args.slice(0, 6)))}`);
			assert.equal(start.cwd, home, "the launcher runs in the workspace root, not the session directory");
			const flag = (name: string) => start.args[start.args.indexOf(name) + 1];
			assert.equal(flag("--workspace-mode"), "home");
			assert.equal(flag("--owned-paths-json"), JSON.stringify(["."]));
		} finally {
			for (const [key, value] of Object.entries({ HOME: saved.home, PI_CODING_AGENT_DIR: saved.agentDir, DELEGATE_GRAPH_DB: saved.db, HERDR_ENV: saved.herdr, HERDR_WORKSPACE_ID: saved.workspace, HERDR_TAB_ID: saved.tab })) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
		}
	});
});
