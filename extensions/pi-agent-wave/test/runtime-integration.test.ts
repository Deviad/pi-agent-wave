import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeContentStore } from "../lib/runtime-content.ts";
import { RuntimeIntegration } from "../lib/runtime-integration.ts";

function base(workspace: string): string { return execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "runtime-integration-")); roots.push(root);
	const workspace = join(root, "repo"); mkdirSync(workspace);
	execFileSync("git", ["init", "-q", workspace]);
	writeFileSync(join(workspace, "a.txt"), "before-a"); writeFileSync(join(workspace, "b.txt"), "before-b");
	execFileSync("git", ["-C", workspace, "add", "."]);
	execFileSync("git", ["-C", workspace, "-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base"]);
	const home = join(root, "private"); mkdirSync(home, { mode: 0o700 });
	const dbPath = join(home, "graph.db");
	const content = new RuntimeContentStore(dbPath);
	const journal = new RuntimeIntegration(dbPath);
	return { root, workspace, dbPath, content, journal };
}

test("prepare retains preimages without writes and reserves the workspace across reopen", () => {
	const { workspace, content, journal, dbPath } = fixture();
	const changes = [{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 }];
	const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate-a", ownedPaths: ["a.txt"], changes });
	assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "before-a");
	journal.close();
	const reopened = new RuntimeIntegration(dbPath);
	try {
		assert.equal(reopened.get(prepared.id).state, "prepared");
		assert.throws(() => reopened.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate-a", ownedPaths: ["a.txt"], changes: [{ ...changes[0], after: content.retain(Buffer.from("different")) }] }), /conflicting candidate integration/);
		assert.throws(() => reopened.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate-b", ownedPaths: ["a.txt"], changes }), /active integration/);
		assert.equal(reopened.apply(prepared.id).state, "applied");
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "after-a");
		assert.equal(reopened.apply(prepared.id).state, "applied");
	} finally { reopened.close(); }
});

test("changed base or any conflicting path prevents the first workspace write", () => {
	const { workspace, content, journal } = fixture();
	try {
		const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate", ownedPaths: ["a.txt", "b.txt"], changes: [
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
			{ path: "b.txt", after: content.retain(Buffer.from("after-b")), mode: 0o644 },
		] });
		writeFileSync(join(workspace, "b.txt"), "user edit");
		assert.throws(() => journal.apply(prepared.id), /conflict/);
		assert.equal(journal.get(prepared.id).state, "needs_reconciliation");
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "before-a");
		writeFileSync(join(workspace, "b.txt"), "before-b");
		execFileSync("git", ["-C", workspace, "-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "changed base"]);
		assert.throws(() => journal.apply(prepared.id), /base revision/);
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "before-a");
	} finally { journal.close(); }
});

test("recovery recognizes an applied file with a lost acknowledgement and can roll back a partial integration", () => {
	const { workspace, content, journal, dbPath } = fixture();
	const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate", ownedPaths: ["a.txt", "b.txt"], changes: [
		{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
		{ path: "b.txt", after: null, mode: 0o644 },
	] });
	assert.equal(journal.advance(prepared.id, "apply").state, "applying");
	assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "after-a");
	journal.close();
	const reopened = new RuntimeIntegration(dbPath);
	try {
		assert.equal(reopened.rollback(prepared.id).state, "rolled_back");
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "before-a");
		assert.equal(readFileSync(join(workspace, "b.txt"), "utf8"), "before-b");
		assert.throws(() => reopened.apply(prepared.id), /rolled_back/);
	} finally { reopened.close(); }
});

test("result digest reconciles a filesystem change made before its journal acknowledgement", () => {
	const { workspace, content, journal } = fixture();
	try {
		const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "candidate", ownedPaths: ["a.txt", "new.txt"], changes: [
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
			{ path: "new.txt", after: content.retain(Buffer.from("new")), mode: 0o644 },
		] });
		writeFileSync(join(workspace, "a.txt"), "after-a");
		assert.equal(journal.apply(prepared.id).state, "applied");
		assert.equal(readFileSync(join(workspace, "new.txt"), "utf8"), "new");
	} finally { journal.close(); }
});

test("ownership, symlink and internal Git paths fail during preparation", () => {
	const { workspace, root, content, journal } = fixture();
	try {
		writeFileSync(join(root, "outside"), "outside"); symlinkSync(join(root, "outside"), join(workspace, "link"));
		for (const path of ["../outside", ".git/config", "link", "b.txt"]) {
			assert.throws(() => journal.prepare({ workspace, baseRevision: base(workspace), candidateId: path, ownedPaths: ["a.txt", "link", ".git"], changes: [{ path, after: content.retain(Buffer.from("replacement")), mode: 0o644 }] }));
		}
		assert.equal(readFileSync(join(root, "outside"), "utf8"), "outside");
	} finally { journal.close(); }
});

function tree(workspace: string): string {
	return execFileSync("find", [".", "-path", "./.git", "-prune", "-o", "-print"], { cwd: workspace, encoding: "utf8" }).split("\n").filter(Boolean).sort().join("\n");
}

test("a candidate file in a new directory integrates with Git checks, and rollback removes the directories it created", () => {
	const { workspace, content, journal } = fixture();
	try {
		mkdirSync(join(workspace, "keep"));
		const before = tree(workspace);
		const changes = [
			{ path: "a/b/new.txt", after: content.retain(Buffer.from("new")), mode: 0o644 },
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
		];
		const applied = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "new-dir", ownedPaths: ["a", "a.txt"], changes });
		assert.equal(existsSync(join(workspace, "a")), false, "prepare writes nothing");
		assert.equal(journal.apply(applied.id).state, "applied");
		assert.equal(readFileSync(join(workspace, "a/b/new.txt"), "utf8"), "new");
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "after-a");

		execFileSync("git", ["-C", workspace, "checkout", "-q", "--", "a.txt"]);
		rmSync(join(workspace, "a"), { recursive: true });
		const partial = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "new-dir-rollback", ownedPaths: ["a", "a.txt"], changes });
		assert.equal(journal.advance(partial.id, "apply").state, "applying");
		assert.equal(readFileSync(join(workspace, "a/b/new.txt"), "utf8"), "new");
		assert.equal(journal.rollback(partial.id).state, "rolled_back");
		assert.equal(tree(workspace), before, "the file and both created directories are gone; keep/ is untouched");
	} finally { journal.close(); }
});

test("rollback keeps parent directories the operator created before preparation", () => {
	const { workspace, content, journal } = fixture();
	try {
		mkdirSync(join(workspace, "a/b"), { recursive: true });
		const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "pre-created", ownedPaths: ["a", "a.txt"], changes: [
			{ path: "a/b/new.txt", after: content.retain(Buffer.from("new")), mode: 0o644 },
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
		] });
		assert.equal(journal.advance(prepared.id, "apply").state, "applying");
		assert.equal(journal.rollback(prepared.id).state, "rolled_back");
		assert.equal(existsSync(join(workspace, "a/b/new.txt")), false);
		assert.equal(existsSync(join(workspace, "a/b")), true, "directories that existed at preparation are never removed");
	} finally { journal.close(); }
});

test("rollback keeps a created directory that gained other content", () => {
	const { workspace, content, journal } = fixture();
	try {
		const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "gained", ownedPaths: ["a", "a.txt"], changes: [
			{ path: "a/b/new.txt", after: content.retain(Buffer.from("new")), mode: 0o644 },
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
		] });
		assert.equal(journal.advance(prepared.id, "apply").state, "applying");
		writeFileSync(join(workspace, "a/operator.txt"), "mine");
		assert.equal(journal.rollback(prepared.id).state, "rolled_back");
		assert.equal(existsSync(join(workspace, "a/b")), false);
		assert.equal(readFileSync(join(workspace, "a/operator.txt"), "utf8"), "mine");
	} finally { journal.close(); }
});

test("a symlinked or nested-repository parent is refused with a message naming the entry", () => {
	const { workspace, root, content, journal } = fixture();
	try {
		mkdirSync(join(root, "elsewhere")); symlinkSync(join(root, "elsewhere"), join(workspace, "linked"));
		mkdirSync(join(workspace, "vendor/lib"), { recursive: true }); execFileSync("git", ["init", "-q", join(workspace, "vendor/lib")]);
		const after = content.retain(Buffer.from("x"));
		assert.throws(() => journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "linked", ownedPaths: ["linked"], changes: [{ path: "linked/new/x.txt", after, mode: 0o644 }] }), /integration parent linked of linked\/new\/x\.txt is missing or not a real directory/);
		assert.throws(() => journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "nested", ownedPaths: ["vendor"], changes: [{ path: "vendor/lib/new/x.txt", after, mode: 0o644 }] }), /integration parent vendor\/lib of vendor\/lib\/new\/x\.txt is a submodule or nested repository/);
		assert.equal(existsSync(join(root, "elsewhere/new")), false);
		assert.equal(existsSync(join(workspace, "vendor/lib/new")), false);
	} finally { journal.close(); }
});

test("preparation refuses dirty, untracked and ignored preimages despite unchanged HEAD", () => {
	const { workspace, content, journal } = fixture();
	try {
		writeFileSync(join(workspace, "a.txt"), "user's uncommitted edit");
		writeFileSync(join(workspace, "untracked.txt"), "user's untracked file");
		writeFileSync(join(workspace, ".git", "info", "exclude"), "ignored.txt\n");
		writeFileSync(join(workspace, "ignored.txt"), "user's ignored file");
		for (const path of ["a.txt", "untracked.txt", "ignored.txt"]) {
			assert.throws(() => journal.prepare({ workspace, baseRevision: base(workspace), candidateId: path, ownedPaths: [path], changes: [{ path, after: content.retain(Buffer.from("replacement")), mode: 0o644 }] }), /dirty|untracked/);
		}
		assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "user's uncommitted edit");
	} finally { journal.close(); }
});

for (const checkpoint of ["writeFileSync", "renameSync"] as const) for (const direction of ["apply", "rollback"] as const) {
	test(`SIGKILL after ${direction} ${checkpoint} preserves recovery direction and candidate bytes`, () => {
		const { workspace, content, journal, dbPath } = fixture();
		const prepared = journal.prepare({ workspace, baseRevision: base(workspace), candidateId: "crash", ownedPaths: ["a.txt", "b.txt"], changes: [
			{ path: "a.txt", after: content.retain(Buffer.from("after-a")), mode: 0o644 },
			{ path: "b.txt", after: content.retain(Buffer.from("after-b")), mode: 0o644 },
		] });
		if (direction === "rollback") journal.advance(prepared.id, "apply");
		journal.close();
		const script = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
import { RuntimeIntegration } from ${JSON.stringify(new URL("../lib/runtime-integration.ts", import.meta.url).href)};
const original = fs[${JSON.stringify(checkpoint)}];
fs[${JSON.stringify(checkpoint)}] = (...args) => { original(...args); process.kill(process.pid, 'SIGKILL'); };
syncBuiltinESMExports();
new RuntimeIntegration(process.argv[1]).advance(process.argv[2], process.argv[3]);`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, dbPath, prepared.id, direction], { encoding: "utf8", timeout: 10_000 });
		assert.equal(child.signal, "SIGKILL", child.stderr);
		const reopened = new RuntimeIntegration(dbPath);
		try {
			assert.equal(reopened.get(prepared.id).direction, direction);
			if (direction === "rollback") {
				assert.throws(() => reopened.apply(prepared.id), /rolling back/);
				assert.equal(reopened.rollback(prepared.id).state, "rolled_back");
				assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "before-a");
			} else {
				assert.equal(reopened.apply(prepared.id).state, "applied");
				assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "after-a");
				assert.equal(readFileSync(join(workspace, "b.txt"), "utf8"), "after-b");
			}
		} finally { reopened.close(); }
	});
}
