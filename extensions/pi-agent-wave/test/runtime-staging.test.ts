import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentFsInvocation, expectedAgentFsDb } from "../lib/agentfs-sandbox.ts";
import { stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

function snapshotAgentFsDb(dbPath: string, snapshotPath: string): void {
	rmSync(snapshotPath, { force: true });
	// The same sqlite backup plus DELETE journal mode scripts/delegate_core.py takes, so the snapshot is
	// self-contained and the live session's -wal is folded in rather than dropped.
	execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", dbPath, snapshotPath]);
}

// A mounted session is the only honest witness for a created directory: a direct `agentfs fs` write into
// the delta database does not record the parent-directory entries a real run records.
function mountedWorker(root: string, sessionId: string, body: string): { base: string; home: string; dbPath: string } {
	const base = join(root, "base");
	const home = join(root, `home-${sessionId}`);
	const privateDir = join(root, `private-${sessionId}`);
	if (!existsSync(base)) mkdirSync(base);
	mkdirSync(home, { mode: 0o700 });
	mkdirSync(privateDir, { mode: 0o700 });
	const script = join(privateDir, "worker.sh");
	writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	const invocation = buildAgentFsInvocation({ sessionId, baseDir: base, homeDir: home, privateDir, command: script, args: [] }, { ...process.env, AGENTFS_HOME: home });
	const run = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
	assert.equal(run.status, 0, run.stderr);
	return { base, home, dbPath: expectedAgentFsDb(home, sessionId) };
}

for (const readOnly of [false, true]) test(`real AgentFS snapshot stages ${readOnly ? "read-only research without exports" : "owned code without host writes"}`, () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-stage-"));
	try {
		const base = join(root, "base"); mkdirSync(base); const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(base, "note.txt"), "before");
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		execFileSync("agentfs", ["init", "--base", base, "snapshot"], { cwd: root, env, stdio: "pipe" });
		const dbPath = join(root, ".agentfs", "snapshot.db");
		const snapshotPath = join(root, "closed.db");
		const snapshot = () => { rmSync(snapshotPath, { force: true }); execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", dbPath, snapshotPath]); };
		execFileSync("agentfs", ["fs", dbPath, "write", "/note.txt", "after"], { cwd: root, env, stdio: "pipe" });
		snapshot();
		const content = new RuntimeContentStore(join(home, "graph.db"));
		const staged = stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: base, baseRevision: "recorded-base", attemptKey: "attempt-1", ownedPaths: readOnly ? [] : ["note.txt"], readOnly }, content);
		assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before");
		assert.equal(staged.files.length, readOnly ? 0 : 1);
		content.verify(staged.manifest);
		if (!readOnly) assert.equal(readFileSync(content.path(staged.files[0]), "utf8"), "after");
		execFileSync("agentfs", ["fs", dbPath, "write", "/unowned.txt", "unowned"], { cwd: root, env, stdio: "pipe" });
		snapshot();
		if (!readOnly) assert.throws(() => stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: base, baseRevision: "recorded-base", attemptKey: "attempt-1", ownedPaths: ["note.txt"], readOnly }, content), /unowned/);
		writeFileSync(`${snapshotPath}-wal`, "uncheckpointed");
		assert.throws(() => stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: base, baseRevision: "recorded-base", attemptKey: "attempt-1", ownedPaths: ["note.txt"], readOnly }, content), /self-contained/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("stages an owned file the worker created inside new directories, and still refuses an unowned sibling", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-stage-dirs-"));
	try {
		const clean = mountedWorker(root, "stage-dirs", "mkdir -p app/topics\nprintf 'module\\n' > app/topics/index.ts");
		const snapshotPath = join(root, "clean.db");
		snapshotAgentFsDb(clean.dbPath, snapshotPath);
		const content = new RuntimeContentStore(join(clean.home, "graph.db"));
		const staged = stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: clean.base, baseRevision: "recorded-base", attemptKey: "attempt-dirs", ownedPaths: ["app/topics/index.ts"], readOnly: false }, content);
		assert.equal(staged.files.length, 1, "only the owned file carries content");
		assert.deepEqual(staged.changes.map((change) => change.path), ["app/topics/index.ts"], "container directories are created implicitly, never staged as changes");
		assert.equal(readFileSync(content.path(staged.files[0]), "utf8"), "module\n");
		assert.equal(existsSync(join(clean.base, "app")), false, "the host tree keeps none of the worker's writes");

		const stray = mountedWorker(root, "stage-dirs-stray", "mkdir -p app/topics\nprintf 'module\\n' > app/topics/index.ts\nprintf 'stray\\n' > app/stray.txt");
		const straySnapshot = join(root, "stray.db");
		snapshotAgentFsDb(stray.dbPath, straySnapshot);
		assert.throws(
			() => stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath: straySnapshot, baseDir: stray.base, baseRevision: "recorded-base", attemptKey: "attempt-stray", ownedPaths: ["app/topics/index.ts"], readOnly: false }, content),
			/unowned changes: app\/stray\.txt/,
			"a container grants its other children no ownership",
		);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("staging scratch does not depend on an inherited TMPDIR, and no shipped module reaches for tmpdir()", () => {
	// The Python lifecycle pins its private directories to /tmp (delegate_core.py TMP_ROOT) because a launcher-supplied
	// TMPDIR can outlive nothing: the 2026-09-16 live run lost a settlement to exactly that. Staging must not trust it either.
	const root = mkdtempSync(join(tmpdir(), "runtime-stage-tmpdir-"));
	const savedTmpdir = process.env.TMPDIR;
	try {
		const base = join(root, "base"); mkdirSync(base);
		const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
		writeFileSync(join(base, "note.txt"), "before");
		const env = { ...process.env, HOME: home, AGENTFS_HOME: home };
		execFileSync("agentfs", ["init", "--base", base, "snapshot"], { cwd: root, env, stdio: "pipe" });
		const dbPath = join(root, ".agentfs", "snapshot.db");
		execFileSync("agentfs", ["fs", dbPath, "write", "/note.txt", "after"], { cwd: root, env, stdio: "pipe" });
		const snapshotPath = join(root, "closed.db");
		execFileSync("python3", ["-c", "import sqlite3,sys; s=sqlite3.connect(sys.argv[1]); t=sqlite3.connect(sys.argv[2]); s.backup(t); t.execute('PRAGMA journal_mode=DELETE'); t.close(); s.close()", dbPath, snapshotPath]);
		const content = new RuntimeContentStore(join(home, "graph.db"));
		// A TMPDIR whose directory has already been reclaimed, as a per-call sandbox does between calls.
		const vanished = mkdtempSync(join(root, "vanished-")); rmSync(vanished, { recursive: true, force: true });
		process.env.TMPDIR = vanished;
		assert.equal(tmpdir(), vanished, "the test really runs with a dead TMPDIR");
		const staged = stageRuntimeAgentFs({ agentFsExecutable: "agentfs", snapshotPath, baseDir: base, baseRevision: "recorded-base", attemptKey: "attempt-1", ownedPaths: ["note.txt"], readOnly: false }, content);
		assert.equal(staged.changes.length, 1);
		assert.equal(readFileSync(content.path(staged.files[0]!), "utf8"), "after");
		assert.equal(readFileSync(join(base, "note.txt"), "utf8"), "before", "staging never writes the host tree");
		// Scoped to this process: the sweep used to match every "pi-wave-staging-" entry in /tmp, so a staging call
		// running concurrently in another test file failed this assertion for a directory it did not create.
		assert.deepEqual(readdirSync("/tmp").filter((entry) => entry.startsWith(`pi-wave-staging-${process.pid}-`)), [], "no scratch directory from this run survives");
	} finally {
		if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
		rmSync(root, { recursive: true, force: true });
	}
	// The grep gate: shipped code under lib/ and scripts/ has no remaining tmpdir() call.
	const shipped = ["lib", "scripts"].flatMap((dir) => readdirSync(join(PACKAGE, dir)).filter((name) => /\.(ts|mjs)$/.test(name)).map((name) => join(dir, name)));
	// Comments may name os.tmpdir() to explain why it is avoided; only code lines count.
	const codeLines = (text: string) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
	const offenders = shipped.filter((file) => codeLines(readFileSync(join(PACKAGE, file), "utf8")).some((line) => /\btmpdir\(\)/.test(line)));
	assert.deepEqual(offenders, [], "shipped modules must allocate temporaries under the pinned root, never os.tmpdir()");
});
