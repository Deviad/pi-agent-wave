import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const INSTALLER = join(PACKAGE, "scripts", "install-ledger.mjs");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(): { agentDir: string; launcher: string; db: string } {
	const root = mkdtempSync(join(tmpdir(), "ledger-install-"));
	dirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return { agentDir, launcher: join(agentDir, "scripts", "delegate-ledger"), db: join(root, "graph.db") };
}

function install(agentDir: string, ...args: string[]): Record<string, any> {
	const env = { ...process.env };
	delete env.PI_CODING_AGENT_DIR;
	// Under `node --test` a child `node` inheriting NODE_TEST_CONTEXT reports to the runner instead of stdout.
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync(process.execPath, [INSTALLER, ...args, "--agent-dir", agentDir], { encoding: "utf8", env });
	if (!result.stdout) throw new Error(`installer printed nothing (status ${result.status}): ${result.stderr}`);
	const report = JSON.parse(result.stdout) as Record<string, any>;
	assert.equal(result.status, report.ok === false ? 1 : 0, result.stderr);
	return report;
}

describe("installing the ledger launcher", () => {
	test("dry-run writes nothing; apply installs a launcher that runs the package's story ledger; a second apply changes nothing", () => {
		const { agentDir, launcher, db } = scratch();
		const planned = install(agentDir);
		assert.equal(planned.mode, "dry-run");
		assert.equal(planned.action, "create");
		assert.equal(existsSync(launcher), false);

		const applied = install(agentDir, "apply");
		assert.equal(applied.changed, true);
		assert.equal(statSync(launcher).mode & 0o777, 0o755);
		assert.ok(readFileSync(launcher, "utf8").includes(`'${join(PACKAGE, "scripts", "delegate-ledger")}'`), "the launcher execs the package's wrapper by its quoted absolute path");
		const { NODE_TEST_CONTEXT: _context, ...ambient } = process.env;
		const read = spawnSync(launcher, ["read", "no-such-story"], { encoding: "utf8", env: { ...ambient, DELEGATE_GRAPH_DB: db } });
		assert.equal(read.status, 0, read.stderr);
		assert.equal(read.stderr, "");
		assert.equal(JSON.parse(read.stdout).action, "ledger_read");

		const again = install(agentDir, "apply");
		assert.equal(again.action, "no-change");
		assert.equal(again.changed, false);
		assert.equal(again.backupPath, null);
	});

	test("a differing file is refused without --force; --force backs it up and rollback restores its bytes and mode", () => {
		const { agentDir, launcher } = scratch();
		mkdirSync(join(agentDir, "scripts"));
		const original = "#!/bin/bash\necho old wrapper\n";
		writeFileSync(launcher, original);
		chmodSync(launcher, 0o700);

		const refused = install(agentDir, "apply");
		assert.equal(refused.ok, false);
		assert.equal(refused.action, "replace");
		assert.match(String(refused.error), /--force/);
		assert.equal(readFileSync(launcher, "utf8"), original);

		const forced = install(agentDir, "apply", "--force", "--backup-id", "ledger-test");
		assert.equal(forced.changed, true);
		assert.notEqual(readFileSync(launcher, "utf8"), original);
		const rolledBack = install(agentDir, "rollback", "--manifest", String(forced.backupPath));
		assert.equal(rolledBack.ok, true);
		assert.equal(readFileSync(launcher, "utf8"), original);
		assert.equal(statSync(launcher).mode & 0o777, 0o700);
	});

	test("rollback of a fresh install removes the launcher it created", () => {
		const { agentDir, launcher } = scratch();
		const applied = install(agentDir, "apply", "--backup-id", "ledger-fresh");
		assert.equal(existsSync(launcher), true);
		install(agentDir, "rollback", "--manifest", String(applied.backupPath));
		assert.equal(existsSync(launcher), false);
	});
});
