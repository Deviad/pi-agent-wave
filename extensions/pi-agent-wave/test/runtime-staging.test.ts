import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageRuntimeAgentFs } from "../lib/runtime-staging.ts";
import { RuntimeContentStore } from "../lib/runtime-content.ts";

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
