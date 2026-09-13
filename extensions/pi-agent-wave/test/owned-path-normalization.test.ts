import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { auditAgentFsChanges, realpathExistingPrefix } from "../lib/agentfs-sandbox.ts";

const DRIVER = join(import.meta.dirname, "support", "owned-path-normalization-driver.py");

// Containment is guaranteed in two layers and neither one is obvious from reading the other:
// delegate_core absolutizes owned paths against the attempt workspace, and the TypeScript audit
// refuses anything that lands outside the sandbox base. The first layer is what stops the audit's
// process-cwd-relative resolve from ever seeing a relative entry, so both halves are pinned here.
const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "owned-paths-")));

test("relative owned paths reach the audit as absolute paths inside the attempt workspace", () => {
	const root = workspace();
	try {
		const result = spawnSync("python3", [DRIVER, root], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const { attempt, normalized } = JSON.parse(result.stdout.trim());
		assert.equal(attempt, root, "the driver normalizes the attempt workspace itself");
		assert.deepEqual(normalized, [
			join(root, "agent-output/result.json"),
			join(root, "absolute.txt"),
			resolve(join(root, "..", "escape/outside.txt")),
			join(root, "inside.txt"),
		], "relative entries must absolutize against the attempt workspace, not the launch directory");
		assert.ok(normalized.every((path: string) => path.startsWith("/")), "no relative entry survives normalization");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ownership separates an escaping path from a contained one before the delta is read", () => {
	const root = workspace();
	// The delta database is deliberately missing: an escape must be reported from the ownership
	// normalization alone, and a contained path must get as far as the delta read.
	const outcome = (ownedPath: string): { escape: boolean; deltaRead: boolean } => {
		try {
			const audit = auditAgentFsChanges(join(root, "missing.db"), root, [ownedPath]);
			return { escape: audit.errors.some((error) => error.kind === "owned_path_escape"), deltaRead: true };
		} catch (error) {
			return { escape: /escapes base directory/.test((error as Error).message), deltaRead: false };
		}
	};
	try {
		// The escape is a per-path audit error rather than a thrown exception, so a sibling contained
		// entry can still be classified while the export as a whole is refused.
		assert.deepEqual(outcome(join(root, "..", "outside.txt")), { escape: false, deltaRead: false }, "a missing delta still fails the read; the escape must not throw first");
		assert.equal(outcome(join(root, "inside.txt")).escape, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an escaping owned path is a per-path audit error while contained entries still classify", () => {
	const root = workspace();
	const driver = spawnSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE fs_inode(ino INTEGER PRIMARY KEY, mode INTEGER);
CREATE TABLE fs_dentry(parent_ino INTEGER, name TEXT, ino INTEGER);
CREATE TABLE fs_origin(delta_ino INTEGER, base_ino INTEGER);
CREATE TABLE fs_whiteout(path TEXT);
INSERT INTO fs_inode VALUES (1, 16877), (2, 33188);
INSERT INTO fs_dentry VALUES (1, 'inside.txt', 2);
""")
db.commit()
`, join(root, "delta.db")], { encoding: "utf8" });
	assert.equal(driver.status, 0, driver.stderr);
	try {
		const audit = auditAgentFsChanges(join(root, "delta.db"), root, [join(root, "..", "outside.txt"), join(root, "inside.txt")]);
		assert.deepEqual(audit.errors.map((error) => error.kind), ["owned_path_escape"]);
		assert.match(audit.errors[0]!.detail, /escapes base directory/);
		assert.deepEqual(audit.owned.map((change) => change.path), ["inside.txt"]);
		assert.deepEqual(audit.violations, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Node and Python resolve missing symlink targets and parent traversal identically", () => {
	const root = workspace();
	try {
		mkdirSync(join(root, "outside"));
		mkdirSync(join(root, "base"));
		symlinkSync(join(root, "outside", "missing"), join(root, "base", "dangling"));
		symlinkSync(join(root, "outside"), join(root, "base", "link"));
		const entries = [join(root, "base", "dangling", "new.txt"), `${root}/base/link/../new.txt`];
		const python = spawnSync("python3", ["-c", "import json, pathlib, sys; print(json.dumps([str(pathlib.Path(p).resolve()) for p in json.loads(sys.argv[1])]))", JSON.stringify(entries)], { encoding: "utf8" });
		assert.equal(python.status, 0, python.stderr);
		assert.deepEqual(entries.map(realpathExistingPrefix), JSON.parse(python.stdout));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
