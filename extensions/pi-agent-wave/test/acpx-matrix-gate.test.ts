import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot } from "./support/repoRoot.ts";

// The matrix gate exists to stop "nothing ran" from looking like "it passed", so what gets pinned
// here is the exit code, not the prose. An earlier draft returned the code from main() without
// assigning it, which made every run green, including one whose child had failed.
const GATE = join(packageRoot, "test/support/acpx-matrix-gate.mjs");
const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "acpx-gate-"));
	directories.push(directory);
	return directory;
}

// The gate requires an existing token file before it will start anything, so the runner cases need a
// real file to point at. Its content is never read: a configured-but-unreachable matrix simply fails
// at the driver, which is the outcome these two cases distinguish.
function configuredEnv(): Record<string, string> {
	const directory = scratch();
	const token = join(directory, "token.txt");
	writeFileSync(token, "placeholder-not-a-real-token");
	return { PI_CLAUDE_OAUTH_TOKEN_FILE: token, MATRIX_EVIDENCE_DIR: join(directory, "evidence") };
}

function runGate(env: Record<string, string | undefined>, args: string[] = []) {
	const clean = { ...process.env } as Record<string, string | undefined>;
	delete clean.PI_CLAUDE_OAUTH_TOKEN_FILE;
	delete clean.ACPX_MATRIX_FILE;
	delete clean.MATRIX_EVIDENCE_DIR;
	// This file runs inside `node --test`, so the child would otherwise inherit test-worker context and
	// report success with its output hidden. The gate strips it too; both sides are cleaned so neither
	// relies on the other.
	delete clean.NODE_TEST_CONTEXT;
	return spawnSync(process.execPath, ["--experimental-strip-types", GATE, ...args], {
		cwd: packageRoot,
		encoding: "utf8",
		env: { ...clean, ...env },
	});
}

describe("real matrix gate", () => {
	test("refuses an unconfigured run without reporting test results", () => {
		const run = runGate({});
		assert.equal(run.status, 1, run.stdout);
		for (const name of ["RUN_REAL_ACPX_MATRIX", "PI_CLAUDE_OAUTH_TOKEN_FILE", "MATRIX_EVIDENCE_DIR"]) {
			assert.match(run.stdout, new RegExp(name), `the refusal has to name ${name}`);
		}
		assert.ok(!/# (pass|fail)/.test(run.stdout), "a refusal must not carry test counts");
	});

	test("refuses a token path that does not exist, naming it", () => {
		const run = runGate({ PI_CLAUDE_OAUTH_TOKEN_FILE: join(scratch(), "absent-token.txt") });
		assert.equal(run.status, 1, run.stdout);
		assert.match(run.stdout, /does not exist/, run.stdout);
	});

	test("a failing runner fails the gate and a passing one does not", () => {
		const failing = join(scratch(), "failing.test.ts");
		const passing = join(scratch(), "passing.test.ts");
		writeFileSync(failing, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("deliberate failure", () => assert.equal(1, 2));\n');
		writeFileSync(passing, 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("deliberate pass", () => assert.equal(1, 1));\n');

		const failed = runGate({ ...configuredEnv(), ACPX_MATRIX_FILE: failing });
		assert.equal(failed.status, 1, `a child that failed must not report success: ${failed.stdout}`);
		assert.match(failed.stdout, /deliberate failure/, "the child's output has to stay visible");

		const passed = runGate({ ...configuredEnv(), ACPX_MATRIX_FILE: passing });
		assert.equal(passed.status, 0, passed.stdout);
	});

	test("a dry run starts nothing, including no evidence directory", () => {
		const env = configuredEnv();
		const run = runGate(env, ["--dry-run"]);
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.stdout, /^would run: /m, "a dry run prints the command it would use");
		assert.match(run.stdout, /acpx-real-matrix\.test\.ts/, "and prints the real matrix as its target");
		const evidence = String(env.MATRIX_EVIDENCE_DIR);
		assert.equal(existsSync(evidence), false, "a dry run must not create the evidence directory");
	});
});