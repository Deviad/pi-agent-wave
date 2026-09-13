import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_IGNORED_PATHS, auditAgentFsChanges, buildAgentFsInvocation, expectedAgentFsDb, exportOwnedAgentFsChanges } from "../lib/agentfs-sandbox.ts";
import { runExport, type ExportConfig } from "./support/agentfs-export.ts";
import { packageRoot } from "./support/repoRoot.ts";
import { workerEnvironment } from "../scripts/acpx-worker.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): { root: string; base: string; home: string; privateDir: string } {
	const root = mkdtempSync(join(tmpdir(), `agentfs-${name}-`));
	roots.push(root);
	const base = join(root, "base");
	const home = join(root, "home");
	const privateDir = join(root, "private");
	for (const path of [base, home, privateDir]) mkdirSync(path, { mode: 0o700 });
	writeFileSync(join(base, "owned.txt"), "original\n");
	return { root, base, home, privateDir };
}

function runScript(f: ReturnType<typeof fixture>, sessionId: string, body: string, environment: NodeJS.ProcessEnv = process.env): string {
	const script = join(f.privateDir, `${sessionId}.sh`);
	writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	chmodSync(script, 0o700);
	const invocation = buildAgentFsInvocation({ sessionId, baseDir: f.base, homeDir: f.home, privateDir: f.privateDir, command: script, args: [] }, environment);
	const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
	assert.equal(result.status, 0, result.stderr);
	return expectedAgentFsDb(f.home, sessionId);
}

interface PreparedAttempt {
	exportConfig: ExportConfig;
	workerConfig: { hostReadOnly: boolean; discardAllChanges: boolean };
	homeDir: string;
	sessionId: string;
	resource: Record<string, unknown>;
}

function prepareAttempt(f: ReturnType<typeof fixture>, node: string, accessMode?: "read-only" | "owned-write", extraArgv: readonly string[] = []): PreparedAttempt {
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
node, mode = sys.argv[4:6]
model = 'openai-codex/gpt-5.6-sol'
argv = ['start', str(private), 'searcher', '--node', node, '--model', model, '--owned-paths-json', json.dumps([str(base / 'owned.txt')])]
if mode: argv += ['--access-mode', mode]
argv += json.loads(sys.argv[6])
args = core.build_parser().parse_args(argv)
task = private / 'task.md'
task.write_text('Temporary preparation fixture; do not dispatch a model.')
resource, _ = core.prepare_acpx_attempt(private, args, {'run_label': 'export-fixture'}, 'fixture-worker', model, task, node)
resource.update({'run_dir': str(private), 'agent': 'fixture-worker', 'role': 'searcher'})
export_config = {'schemaVersion': 1, 'agentFsExecutable': 'agentfs', 'dbPath': resource['agentfs_db_path'], 'baseDir': resource['base_dir'], 'ownedPaths': resource['owned_paths'], 'ignoredPaths': resource['ignored_paths'], 'discardAllChanges': resource['read_only'], 'resultPath': str(private / 'export-result.json')}
print(json.dumps({'exportConfig': export_config, 'workerConfig': json.loads(Path(resource['worker_config']).read_text()), 'homeDir': resource['agentfs_home'], 'sessionId': resource['agentfs_session'], 'resource': resource}))
`;
	const result = spawnSync("python3", ["-c", script, join(packageRoot, "scripts"), f.base, f.privateDir, node, accessMode ?? "", JSON.stringify(extraArgv)], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	assert.equal(result.status, 0, result.stderr);
	const prepared: PreparedAttempt = JSON.parse(result.stdout);
	return prepared;
}

describe("AgentFS operation-attempt sandbox", () => {
	test("worker Git status avoids optional index writes without relaxing export ownership", () => {
		const f = fixture("git-index-refresh");
		for (const args of [["init", "--quiet"], ["add", "owned.txt"]]) {
			const result = spawnSync("git", args, { cwd: f.base, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const originalIndex = readFileSync(join(f.base, ".git", "index"));
		const owned = [join(f.base, "owned.txt")];
		const command = "git status --porcelain >/dev/null\nprintf 'accepted\\n' > owned.txt";
		const controlDb = runScript(f, "git-index-control", command, { ...process.env, GIT_OPTIONAL_LOCKS: "1" });
		const control = auditAgentFsChanges(controlDb, f.base, owned);
		assert.ok(control.violations.some((change) => change.path === ".git/index"));
		assert.throws(() => exportOwnedAgentFsChanges("agentfs", controlDb, f.base, control), /unowned changes/);

		const environment = workerEnvironment({ agent: "pi", acpxHome: f.home });
		const db = runScript(f, "git-index-worker", command, environment);
		const audit = auditAgentFsChanges(db, f.base, owned);
		assert.deepEqual(audit.violations, []);
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
		assert.deepEqual(readFileSync(join(f.base, ".git", "index")), originalIndex);

		const tamperedDb = runScript(f, "git-index-tampered", "printf 'tampered\\n' > .git/index", environment);
		const tampered = auditAgentFsChanges(tamperedDb, f.base, owned);
		assert.ok(tampered.violations.some((change) => change.path === ".git/index"));
		assert.throws(() => exportOwnedAgentFsChanges("agentfs", tamperedDb, f.base, tampered), /unowned changes/);
		assert.deepEqual(readFileSync(join(f.base, ".git", "index")), originalIndex);
	});

	test("research preparation discards read-only overlay changes", () => {
		const f = fixture("research-preparation");
		const prepared = prepareAttempt(f, "search");
		runScript({ ...f, home: prepared.homeDir }, prepared.sessionId, "printf 'temporary\\n' > unowned.txt");
		assert.equal(runExport(prepared.exportConfig), 0);
		assert.equal(prepared.workerConfig.hostReadOnly, true);
		assert.equal(prepared.workerConfig.discardAllChanges, true);
		const result = JSON.parse(readFileSync(prepared.exportConfig.resultPath, "utf8"));
		assert.ok(result.discardedReadOnlyChanges > 0);
		assert.equal(existsSync(join(f.base, "unowned.txt")), false);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");
	});

	test("explicit access mode overrides legacy node defaults", () => {
		for (const [node, accessMode, readOnly] of [["implement", "read-only", true], ["search", "owned-write", false]] as const) {
			const f = fixture("explicit-access");
			const prepared = prepareAttempt(f, node, accessMode);
			runScript({ ...f, home: prepared.homeDir }, prepared.sessionId, "printf 'accepted\\n' > owned.txt");
			assert.equal(prepared.workerConfig.hostReadOnly, readOnly);
			assert.equal(prepared.workerConfig.discardAllChanges, readOnly);
			assert.equal(prepared.exportConfig.discardAllChanges, readOnly);
			assert.equal(runExport(prepared.exportConfig), 0);
			assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), readOnly ? "original\n" : "accepted\n");
		}
	});

	test("builds the exact no-default-allows direct argv", () => {
		const f = fixture("argv");
		const invocation = buildAgentFsInvocation({ sessionId: "attempt-1", baseDir: f.base, homeDir: f.home, privateDir: f.privateDir, command: "/bin/true", args: ["value"] }, { PATH: "/bin" });
		assert.equal(invocation.executable, "agentfs");
		assert.deepEqual(invocation.args, ["run", "--session", "attempt-1", "--no-default-allows", "--allow", f.privateDir, "/bin/true", "value"]);
		assert.equal(invocation.env.HOME, f.home);
	});

	test("keeps repository writes copy-on-write and rejects unowned overlay paths", () => {
		const f = fixture("audit");
		const db = runScript(f, "attempt-audit", "printf 'changed\\n' > owned.txt\nprintf 'escape\\n' > unowned.txt");
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");
		const audit = auditAgentFsChanges(db, f.base, [join(f.base, "owned.txt")]);
		assert.deepEqual(audit.owned.map((change) => change.path), ["owned.txt"]);
		assert.ok(audit.violations.some((change) => change.path === "unowned.txt"));
		assert.throws(() => exportOwnedAgentFsChanges("agentfs", db, f.base, audit), /unowned changes/);
	});

	test("prevents writes through credential symlinks to real provider homes", () => {
		const f = fixture("credential-boundary");
		const target = join(process.env.HOME ?? "", `.pi-agent-wave-agentfs-boundary-${process.pid}`);
		rmSync(target, { force: true });
		writeFileSync(target, "unchanged\n", { mode: 0o600 });
		const link = join(f.privateDir, "credential-link");
		symlinkSync(target, link);
		try {
			const script = join(f.privateDir, "credential-write.sh");
			writeFileSync(script, `#!/bin/sh\nprintf 'changed\\n' > '${link}' 2>/dev/null\nprintf '%s\\n' "$?" > '${f.privateDir}/write-status'\nexit 0\n`, { mode: 0o700 });
			const invocation = buildAgentFsInvocation({ sessionId: "credential-boundary", baseDir: f.base, homeDir: f.home, privateDir: f.privateDir, command: script, args: [] });
			const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
			assert.equal(result.status, 0, result.stderr);
			assert.notEqual(readFileSync(join(f.privateDir, "write-status"), "utf8").trim(), "0");
			assert.equal(readFileSync(target, "utf8"), "unchanged\n");
		} finally {
			rmSync(target, { force: true });
		}
		assert.equal(existsSync(target), false);
	});

	test("records and discards every read-only overlay change without host export", () => {
		const f = fixture("discard-read-only");
		const db = runScript(f, "attempt-discard", "printf 'ephemeral\\n' > unowned.txt");
		const resultPath = join(f.privateDir, "discard-result.json");
		assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: "agentfs", dbPath: db, baseDir: f.base, ownedPaths: [], ignoredPaths: [], discardAllChanges: true, resultPath }), 0);
		const result = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(result.exported, true);
		assert.equal(result.violations.length, 0);
		assert.ok(result.discardedReadOnlyChanges > 0);
		assert.equal(existsSync(join(f.base, "unowned.txt")), false);
	});

	test("unchanged large files do not become ownership violations", () => {
		const f = fixture("large-unchanged");
		const largePath = join(f.base, "large.txt");
		const content = Buffer.alloc(5 * 1024 * 1024, "a");
		writeFileSync(largePath, content);
		const ownedPaths = [join(f.base, "owned.txt")];
		const db = runScript(f, "large-unchanged", "cat large.txt > /dev/null\nprintf 'accepted\\n' > owned.txt");
		const audit = auditAgentFsChanges(db, f.base, ownedPaths);
		assert.deepEqual(audit.violations, []);
		assert.deepEqual(audit.owned.map((change) => change.path), ["owned.txt"]);
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
		assert.deepEqual(readFileSync(largePath), content);

		const changedDb = runScript(f, "large-changed", "printf 'changed\\n' > large.txt\nprintf 'rejected\\n' > owned.txt");
		const changedAudit = auditAgentFsChanges(changedDb, f.base, ownedPaths);
		assert.ok(changedAudit.violations.some((change) => change.path === "large.txt"));
		assert.throws(() => exportOwnedAgentFsChanges("agentfs", changedDb, f.base, changedAudit), /unowned changes/);
		assert.deepEqual(readFileSync(largePath), content);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
	});

	test("exports large owned files byte-for-byte", () => {
		const f = fixture("large-export");
		const content = Buffer.alloc(5 * 1024 * 1024, "b");
		const payload = join(f.privateDir, "payload.txt");
		writeFileSync(payload, content);
		const db = runScript(f, "large-export", `cp '${payload}' owned.txt`);
		const audit = auditAgentFsChanges(db, f.base, [join(f.base, "owned.txt")]);
		assert.deepEqual(audit.violations, []);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.deepEqual(readFileSync(join(f.base, "owned.txt")), content);
	});

	test("a failed agentfs cat during audit is an audit error, not a modified file", () => {
		const f = fixture("audit-cat-failure");
		writeFileSync(join(f.base, "untouched.txt"), "same\n");
		const owned = [join(f.base, "owned.txt")];
		const db = runScript(f, "audit-cat-failure", "cat untouched.txt > /dev/null\nprintf 'accepted\\n' > owned.txt");
		const broken = join(f.privateDir, "broken-agentfs.sh");
		writeFileSync(broken, "#!/bin/sh\necho 'simulated agentfs outage' >&2\nexit 7\n", { mode: 0o700 });
		const audit = auditAgentFsChanges(db, f.base, owned, { agentFsExecutable: broken });
		assert.deepEqual(audit.violations, [], "an unreadable overlay file must not be promoted to an unowned change");
		assert.ok(audit.errors.some((error) => error.path === "untouched.txt" && error.kind === "audit_error" && /exited 7/.test(error.detail)), JSON.stringify(audit.errors));
		assert.throws(() => exportOwnedAgentFsChanges(broken, db, f.base, audit), /AgentFS audit error/);
		assert.throws(() => exportOwnedAgentFsChanges(broken, db, f.base, audit), (error: Error) => !/unowned changes/.test(error.message));
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");

		const resultPath = join(f.privateDir, "cat-failure-result.json");
		assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: broken, dbPath: db, baseDir: f.base, ownedPaths: owned, ignoredPaths: [], discardAllChanges: false, resultPath }), 2);
		const receipt = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(receipt.exported, false);
		assert.deepEqual(receipt.violations, []);
		assert.match(receipt.auditError, /AgentFS audit error/);
		assert.doesNotMatch(receipt.auditError, /unowned changes/);
		assert.equal(receipt.errors[0].kind, "audit_error");
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");

		// A genuine difference still surfaces as a violation with the working binary.
		const genuine = auditAgentFsChanges(db, f.base, []);
		assert.deepEqual(genuine.errors, []);
		assert.ok(genuine.violations.some((change) => change.path === "owned.txt"));
	});

	test("private launch preparation ignores only the Git index by default and accepts explicit ignored paths", () => {
		const f = fixture("strict-default-config");
		assert.deepEqual(DEFAULT_IGNORED_PATHS, [".git/index"]);
		const prepared = prepareAttempt(f, "implement", "owned-write");
		assert.deepEqual(prepared.exportConfig.ignoredPaths, [join(realpathSync(f.base), ".git/index")]);
		const explicitEmpty = prepareAttempt(fixture("strict-empty-config"), "implement", "owned-write", ["--ignored-paths-json", "[]"]);
		assert.deepEqual(explicitEmpty.exportConfig.ignoredPaths, [], "an explicit empty list restores the strict audit");
		const g = fixture("explicit-ignore-config");
		const overridden = prepareAttempt(g, "implement", "owned-write", ["--ignored-paths-json", '[".git/index"]']);
		assert.deepEqual(overridden.exportConfig.ignoredPaths, [join(realpathSync(g.base), ".git/index")]);
	});

	test("host read failures produce an audit receipt and preserve owned files", () => {
		const f = fixture("host-read-error");
		const untouched = join(f.base, "untouched.txt");
		writeFileSync(untouched, "same\n");
		const db = runScript(f, "host-read-error", "cat untouched.txt > /dev/null\nprintf 'accepted\\n' > owned.txt");
		chmodSync(untouched, 0);
		try {
			assert.throws(() => readFileSync(untouched), /EACCES|EPERM/, "requires real denied host reads");
			const resultPath = join(f.privateDir, "host-read-result.json");
			assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: "agentfs", dbPath: db, baseDir: f.base, ownedPaths: [join(f.base, "owned.txt")], ignoredPaths: [], discardAllChanges: false, resultPath }), 2);
			const receipt = JSON.parse(readFileSync(resultPath, "utf8"));
			assert.equal(receipt.exported, false);
			assert.deepEqual(receipt.violations, []);
			assert.ok(receipt.errors.some((error: { path: string; kind: string }) => error.path === "untouched.txt" && error.kind === "audit_error"));
			assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");
		} finally {
			chmodSync(untouched, 0o600);
		}
	});

	test("audit uses the configured agentfs executable when PATH lacks agentfs", () => {
		const f = fixture("configured-executable");
		const realAgentFs = spawnSync("sh", ["-c", "command -v agentfs"], { encoding: "utf8" }).stdout.trim();
		assert.ok(realAgentFs, "agentfs must be installed for this suite");
		writeFileSync(join(f.base, "untouched.txt"), "same\n");
		const owned = [join(f.base, "owned.txt")];
		const db = runScript(f, "configured-executable", "cat untouched.txt > /dev/null\nprintf 'accepted\\n' > owned.txt");
		const originalPath = process.env.PATH;
		process.env.PATH = "/usr/bin:/bin";
		try {
			assert.equal(spawnSync("agentfs", ["--version"], { encoding: "utf8" }).error?.code, "ENOENT", "PATH must genuinely lack agentfs for this proof");
			const resultPath = join(f.privateDir, "configured-result.json");
			assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: realAgentFs, dbPath: db, baseDir: f.base, ownedPaths: owned, ignoredPaths: [], discardAllChanges: false, resultPath }), 0);
			const receipt = JSON.parse(readFileSync(resultPath, "utf8"));
			assert.deepEqual(receipt.violations, []);
			assert.deepEqual(receipt.errors, []);
			assert.equal(receipt.exported, true);
		} finally {
			process.env.PATH = originalPath;
		}
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
	});

	test("owned paths resolve through a symlinked base and escapes are per-path errors", () => {
		const f = fixture("realpath-owned");
		const linkRoot = join(f.root, "link");
		symlinkSync(f.base, linkRoot);
		const db = runScript(f, "realpath-owned", "printf 'accepted\\n' > owned.txt");
		// Base given through the symlink, owned path given through the real directory (and vice versa).
		for (const [base, ownedPath] of [[linkRoot, join(realpathSync(f.base), "owned.txt")], [realpathSync(f.base), join(linkRoot, "owned.txt")]] as const) {
			const audit = auditAgentFsChanges(db, base, [ownedPath]);
			assert.deepEqual(audit.errors, [], JSON.stringify(audit.errors));
			assert.deepEqual(audit.owned.map((change) => change.path), ["owned.txt"]);
			assert.deepEqual(audit.violations, []);
		}
		// An owned path that does not exist yet still resolves through its existing prefix.
		const pending = auditAgentFsChanges(db, linkRoot, [join(linkRoot, "not-yet", "created.txt"), join(f.base, "owned.txt")]);
		assert.deepEqual(pending.errors, []);
		assert.deepEqual(pending.owned.map((change) => change.path), ["owned.txt"]);

		const escaped = auditAgentFsChanges(db, f.base, [join(f.base, "..", "outside.txt"), join(f.base, "owned.txt")]);
		assert.equal(escaped.errors.length, 1);
		assert.equal(escaped.errors[0]!.kind, "owned_path_escape");
		assert.deepEqual(escaped.owned.map((change) => change.path), ["owned.txt"], "the contained entry still classifies while the escape is reported");
		assert.throws(() => exportOwnedAgentFsChanges("agentfs", db, f.base, escaped), /AgentFS audit error/);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");

		const resultPath = join(f.privateDir, "escape-result.json");
		assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: "agentfs", dbPath: db, baseDir: f.base, ownedPaths: [join(f.base, "..", "outside.txt")], ignoredPaths: [], discardAllChanges: false, resultPath }), 2);
		const receipt = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(receipt.exported, false);
		assert.equal(receipt.errors[0].kind, "owned_path_escape");
		assert.match(receipt.auditError, /AgentFS audit error/);
	});

	test("whole-base ownership is refused unless ownWholeBase is set", () => {
		const f = fixture("whole-base");
		const db = runScript(f, "whole-base", "printf 'accepted\\n' > owned.txt\nprintf 'new\\n' > other.txt");
		for (const entry of [f.base, `${f.base}/`, join(f.base, "sub", "..")]) {
			const refused = auditAgentFsChanges(db, f.base, [entry]);
			assert.equal(refused.owned.length, 0, entry);
			assert.ok(refused.errors.some((error) => error.kind === "owned_path_escape" && /whole base/.test(error.detail)), JSON.stringify(refused.errors));
			assert.throws(() => exportOwnedAgentFsChanges("agentfs", db, f.base, refused), /AgentFS audit error/);
		}
		const resultPath = join(f.privateDir, "whole-base-result.json");
		assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: "agentfs", dbPath: db, baseDir: f.base, ownedPaths: [f.base], ignoredPaths: [], discardAllChanges: false, resultPath }), 2);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "original\n");
		assert.equal(existsSync(join(f.base, "other.txt")), false);

		const allowed = auditAgentFsChanges(db, f.base, [f.base], { ownWholeBase: true });
		assert.deepEqual(allowed.errors, []);
		// macOS may add AppleDouble `._*` entries inside the overlay; under whole-base ownership they are owned too.
		assert.deepEqual(allowed.owned.map((change) => change.path).filter((path) => !path.startsWith("._")).sort(), ["other.txt", "owned.txt"]);
		assert.equal(runExport({ schemaVersion: 1, agentFsExecutable: "agentfs", dbPath: db, baseDir: f.base, ownedPaths: [f.base], ignoredPaths: [], discardAllChanges: false, resultPath, ownWholeBase: true }), 0);
		assert.equal(readFileSync(join(f.base, "other.txt"), "utf8"), "new\n");
	});

	test("platform metadata is discarded outside ownership and exported inside it", () => {
		const f = fixture("platform-metadata");
		mkdirSync(join(f.base, "out"));
		const owned = [join(f.base, "out")];
		const db = runScript(f, "platform-metadata", "printf 'finder\\n' > .DS_Store\nprintf 'fork\\n' > ._owned.txt\nprintf 'kept\\n' > out/.DS_Store\nprintf 'fork\\n' > out/._standalone\nprintf 'result\\n' > out/result.txt");
		const audit = auditAgentFsChanges(db, f.base, owned);
		assert.deepEqual(audit.errors, []);
		assert.deepEqual(audit.violations, [], "unowned Finder metadata must be discarded rather than refused");
		const ignored = audit.ignored.map((change) => change.path);
		assert.ok(ignored.includes(".DS_Store") && ignored.includes("._owned.txt"), JSON.stringify(ignored));
		assert.ok(ignored.every((path) => /(^|\/)(\._|\.DS_Store$)/.test(path)), "only platform metadata may be silently ignored");
		const ownedPaths = audit.owned.map((change) => change.path);
		for (const path of ["out/.DS_Store", "out/._standalone", "out/result.txt"]) assert.ok(ownedPaths.includes(path), JSON.stringify(ownedPaths));
		assert.ok(ownedPaths.every((path) => path.startsWith("out/")), JSON.stringify(ownedPaths));
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.equal(readFileSync(join(f.base, "out", ".DS_Store"), "utf8"), "kept\n");
		assert.equal(readFileSync(join(f.base, "out", "._standalone"), "utf8"), "fork\n");
		assert.equal(readFileSync(join(f.base, "out", "result.txt"), "utf8"), "result\n");
		assert.equal(existsSync(join(f.base, ".DS_Store")), false);
		assert.equal(existsSync(join(f.base, "._owned.txt")), false);
		assert.equal(dirname(join(f.base, "out", "result.txt")), join(f.base, "out"));
	});

	test("prepared attempts ignore the Git index by default, take explicit ignore lists, and otherwise reject bookkeeping edits", () => {
		const pythonDefaults = spawnSync("python3", ["-c", "import sys, json; sys.path.insert(0, sys.argv[1]); import delegate_core as core; print(json.dumps(list(core.DEFAULT_IGNORED_PATHS)))", join(packageRoot, "scripts")], { encoding: "utf8" });
		assert.equal(pythonDefaults.status, 0, pythonDefaults.stderr);
		assert.deepEqual(JSON.parse(pythonDefaults.stdout), [...DEFAULT_IGNORED_PATHS], "the Python and TypeScript defaults must not drift");
		assert.deepEqual([...DEFAULT_IGNORED_PATHS], [".git/index"]);

		const f = fixture("ignored-defaults");
		for (const args of [["init", "--quiet"], ["add", "owned.txt"]]) {
			const result = spawnSync("git", args, { cwd: f.base, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		const originalIndex = readFileSync(join(f.base, ".git", "index"));
		const originalConfig = readFileSync(join(f.base, ".git", "config"));
		const ignoredPaths = [".git/index", ".git/ORIG_HEAD", ".git/FETCH_HEAD"];
		const prepared = prepareAttempt(f, "implement", "owned-write", ["--ignored-paths-json", JSON.stringify(ignoredPaths)]);
		assert.deepEqual(prepared.exportConfig.ignoredPaths, ignoredPaths.map((path) => join(realpathSync(f.base), path)));

		// Index refresh plus an owned write: exported, with the index change discarded rather than refused.
		runScript({ ...f, home: prepared.homeDir }, prepared.sessionId, "printf 'refreshed\\n' > .git/index\nprintf 'bookkeeping\\n' > .git/ORIG_HEAD\nprintf 'accepted\\n' > owned.txt");
		assert.equal(runExport(prepared.exportConfig), 0);
		let receipt = JSON.parse(readFileSync(prepared.exportConfig.resultPath, "utf8"));
		assert.deepEqual(receipt.violations, []);
		// macOS AppleDouble `._*` companions are platform metadata and are filtered from this assertion.
		const nonMetadata = (changes: { path: string }[]): string[] => changes.map((change) => change.path).filter((path) => !/(^|\/)\._/.test(path)).sort();
		assert.deepEqual(nonMetadata(receipt.ignored), [".git/ORIG_HEAD", ".git/index"]);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
		assert.deepEqual(readFileSync(join(f.base, ".git", "index")), originalIndex);
		assert.equal(existsSync(join(f.base, ".git", "ORIG_HEAD")), false);

		// A deliberate .git edit elsewhere is still an ownership violation.
		const second = prepareAttempt(fixture("ignored-config"), "implement", "owned-write", ["--ignored-paths-json", JSON.stringify(ignoredPaths)]);
		const g = { ...f, base: second.exportConfig.baseDir, home: second.homeDir };
		for (const args of [["init", "--quiet"], ["add", "owned.txt"]]) {
			const result = spawnSync("git", args, { cwd: g.base, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		runScript(g, second.sessionId, "printf 'refreshed\\n' > .git/index\nprintf '[core]\\n\\thooksPath = /tmp/evil\\n' > .git/config\nprintf 'rejected\\n' > owned.txt");
		assert.equal(runExport(second.exportConfig), 2);
		receipt = JSON.parse(readFileSync(second.exportConfig.resultPath, "utf8"));
		assert.deepEqual(receipt.violations.map((change: { path: string }) => change.path), [".git/config"]);
		assert.deepEqual(nonMetadata(receipt.ignored), [".git/index"]);
		assert.equal(readFileSync(join(g.base, "owned.txt"), "utf8"), "original\n");
		assert.deepEqual(readFileSync(join(g.base, ".git", "config")), originalConfig);
		assert.notEqual(readFileSync(join(g.base, ".git", "config"), "utf8"), "[core]\n\thooksPath = /tmp/evil\n");
		assert.ok(originalConfig.length > 0);

		// Default preparation discards an index refresh and exports the owned write; the host index keeps its bytes.
		const third = prepareAttempt(fixture("ignored-none"), "implement", "owned-write");
		assert.deepEqual(third.exportConfig.ignoredPaths, [join(realpathSync(third.exportConfig.baseDir), ".git/index")]);
		const h = { ...f, base: third.exportConfig.baseDir, home: third.homeDir };
		spawnSync("git", ["init", "--quiet"], { cwd: h.base });
		spawnSync("git", ["add", "owned.txt"], { cwd: h.base });
		const thirdIndex = readFileSync(join(h.base, ".git", "index"));
		runScript(h, third.sessionId, "printf 'refreshed\\n' > .git/index\nprintf 'accepted\\n' > owned.txt");
		assert.equal(runExport(third.exportConfig), 0);
		receipt = JSON.parse(readFileSync(third.exportConfig.resultPath, "utf8"));
		assert.deepEqual(receipt.violations, []);
		assert.deepEqual(nonMetadata(receipt.ignored), [".git/index"]);
		assert.equal(readFileSync(join(h.base, "owned.txt"), "utf8"), "accepted\n");
		assert.deepEqual(readFileSync(join(h.base, ".git", "index")), thirdIndex);

		// An explicit empty ignore list restores the strict audit: the same index write is a violation.
		const fourth = prepareAttempt(fixture("ignored-strict"), "implement", "owned-write", ["--ignored-paths-json", "[]"]);
		assert.deepEqual(fourth.exportConfig.ignoredPaths, []);
		const k = { ...f, base: fourth.exportConfig.baseDir, home: fourth.homeDir };
		spawnSync("git", ["init", "--quiet"], { cwd: k.base });
		runScript(k, fourth.sessionId, "printf 'refreshed\\n' > .git/index\nprintf 'accepted\\n' > owned.txt");
		assert.equal(runExport(fourth.exportConfig), 2);
		receipt = JSON.parse(readFileSync(fourth.exportConfig.resultPath, "utf8"));
		assert.deepEqual(receipt.violations.map((change: { path: string }) => change.path), [".git/index"]);
		assert.equal(readFileSync(join(k.base, "owned.txt"), "utf8"), "original\n");
	});

	test("the delta snapshot folds in the WAL and fails closed when SQLite backup fails", () => {
		const f = fixture("snapshot-backup");
		const script = `
import json, sqlite3, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
root = Path(sys.argv[2])
attempt = root / 'attempt'; attempt.mkdir()
source = attempt / 'agentfs-home' / 'delta.db'
source.parent.mkdir()
db = sqlite3.connect(source)
db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT)')
db.executemany('INSERT INTO rows(value) VALUES (?)', [(f'row-{i}',) for i in range(50)])
db.commit()  # committed, but still living in the -wal until a checkpoint
wal_present = (attempt / 'agentfs-home' / 'delta.db-wal').exists()
resource = {'agentfs_db_path': str(source), 'attempt_dir': str(attempt)}  # runtime resources carry no legacy export config
snapshot = core.snapshot_agentfs_db(resource)
db.close()
copied = sqlite3.connect(f'file:{snapshot}?mode=ro', uri=True)
count = copied.execute('SELECT count(*) FROM rows').fetchone()[0]
integrity = copied.execute('PRAGMA integrity_check').fetchone()[0]
copied.close()
backup = {'method': resource['agentfs_snapshot']['method'], 'count': count, 'integrity': integrity, 'walPresent': wal_present,
          'snapshotWal': (snapshot.parent / 'delta.db-wal').exists(), 'recordedPath': resource['agentfs_snapshot']['path'] == str(snapshot), 'strayFiles': sorted(p.name for p in attempt.iterdir()),
          'mode': oct(snapshot.stat().st_mode & 0o777)}
# Corrupt source: never pass a raw copy to the export auditor.
source.write_bytes(b'not a sqlite database at all')
(attempt / 'agentfs-home' / 'delta.db-wal').write_bytes(b'wal-bytes')
resource2 = {'agentfs_db_path': str(source), 'attempt_dir': str(attempt)}
try:
    core.snapshot_agentfs_db(resource2)
except core.DelegateError as error:
    failure = str(error)
else:
    failure = None
fallback = {'method': resource2['agentfs_snapshot']['method'], 'error': resource2['agentfs_snapshot']['backupError'],
            'failure': failure, 'partialFiles': list(p.name for p in snapshot.parent.iterdir())}
# A real exclusive writer lock must not leave backup retrying forever.
source.unlink()
Path(str(source) + '-wal').unlink(missing_ok=True)
locked = sqlite3.connect(source)
locked.execute('CREATE TABLE locked_rows(id INTEGER)')
locked.commit()
locked.execute('BEGIN EXCLUSIVE')
started = time.monotonic()
try:
    core.snapshot_agentfs_db(resource2, timeout_ms=100)
except core.DelegateError as error:
    lock_error = str(error)
else:
    lock_error = None
finally:
    locked.rollback(); locked.close()
elapsed = time.monotonic() - started
print(json.dumps({'backup': backup, 'fallback': fallback, 'lockError': lock_error, 'elapsed': elapsed}))
`;
		const result = spawnSync("python3", ["-c", script, join(packageRoot, "scripts"), f.privateDir], { encoding: "utf8", timeout: 5000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
		assert.equal(result.status, 0, result.stderr);
		const { backup, fallback, lockError, elapsed } = JSON.parse(result.stdout);
		assert.equal(backup.walPresent, true, "the fixture must exercise a WAL-resident commit");
		assert.equal(backup.method, "backup");
		assert.equal(backup.count, 50, "the backup must fold the WAL into one consistent file");
		assert.equal(backup.integrity, "ok");
		assert.equal(backup.snapshotWal, false, "a backup snapshot needs no sidecar files");
		assert.equal(backup.recordedPath, true, "the resource records the snapshot path for the settle configuration");
		assert.deepEqual(backup.strayFiles, ["agentfs-home", "agentfs-snapshot"], "no legacy export configuration is written");
		assert.equal(backup.mode, "0o600");
		assert.equal(fallback.method, "failed");
		assert.ok(fallback.error, "the receipt must record why backup failed");
		assert.match(fallback.failure, /AgentFS snapshot failed/);
		assert.deepEqual(fallback.partialFiles, []);
		assert.match(lockError, /backup timed out after 100ms/);
		assert.ok(elapsed < 2, `backup must settle within a bounded time: ${elapsed}s`);
	});

	test("exports only audited owned files after successful execution", () => {
		const f = fixture("export");
		const db = runScript(f, "attempt-export", "printf 'accepted\\n' > owned.txt");
		const audit = auditAgentFsChanges(db, f.base, [join(f.base, "owned.txt")]);
		assert.equal(audit.violations.length, 0);
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
	});
});
