import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { auditAgentFsChanges, buildAgentFsInvocation, expectedAgentFsDb, exportOwnedAgentFsChanges } from "../lib/agentfs-sandbox.ts";
import { runExport } from "../scripts/agentfs-export.ts";

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

function runScript(f: ReturnType<typeof fixture>, sessionId: string, body: string): string {
	const script = join(f.privateDir, `${sessionId}.sh`);
	writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
	chmodSync(script, 0o700);
	const invocation = buildAgentFsInvocation({ sessionId, baseDir: f.base, homeDir: f.home, privateDir: f.privateDir, command: script, args: [] });
	const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8", shell: false, timeout: 120_000 });
	assert.equal(result.status, 0, result.stderr);
	return expectedAgentFsDb(f.home, sessionId);
}

describe("AgentFS operation-attempt sandbox", () => {
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

	test("exports only audited owned files after successful execution", () => {
		const f = fixture("export");
		const db = runScript(f, "attempt-export", "printf 'accepted\\n' > owned.txt");
		const audit = auditAgentFsChanges(db, f.base, [join(f.base, "owned.txt")]);
		assert.equal(audit.violations.length, 0);
		exportOwnedAgentFsChanges("agentfs", db, f.base, audit);
		assert.equal(readFileSync(join(f.base, "owned.txt"), "utf8"), "accepted\n");
	});
});
