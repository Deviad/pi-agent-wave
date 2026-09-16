import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

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
		assert.deepEqual(readdirSync("/tmp").filter((entry) => entry.startsWith("pi-wave-staging-") && statSync(join("/tmp", entry)).mtimeMs > Date.now() - 60_000), [], "no scratch directory from this run survives");
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
