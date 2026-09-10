#!/usr/bin/env -S node --experimental-strip-types
// Entry point for the real ACPX lifecycle matrix, and the reason it exists rather than a bare
// `node --test` line: `node --test` exits 0 after skipping every case, so an unconfigured run looks
// green. This refuses instead. The test file keeps its own skip semantics, because the production
// audit also drives it with RUN_REAL_ACPX_MATRIX=1 and validates its summary.
//
// It dispatches real worker sessions and spends provider credits, so nothing here runs without a
// configured token file. --dry-run prints the exact command and starts nothing.
//
// Environment:
//   PI_CLAUDE_OAUTH_TOKEN_FILE  required, must point at an existing raw-token file (Claude case)
//   RUN_REAL_ACPX_MATRIX        set to "1" here; the test file will not run the cases without it
//   MATRIX_EVIDENCE_DIR         where the run writes its per-agent evidence; defaults to
//                               agent-output/production-acpx-worker-backend/final-matrix at the repo root
//   ACPX_MATRIX_FILE            rehearsal seam: run a different target file instead of the real
//                               matrix, so the launch wiring can be proved without provider calls

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supportDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(supportDir, "../..");
const repoRoot = resolve(packageRoot, "../..");
const defaultEvidenceDir = join(repoRoot, "agent-output/production-acpx-worker-backend/final-matrix");

export function matrixPlan(env, args = process.argv.slice(2)) {
	const tokenFile = env.PI_CLAUDE_OAUTH_TOKEN_FILE ?? "";
	const problems = [];
	if (!tokenFile) problems.push("PI_CLAUDE_OAUTH_TOKEN_FILE is not set: the Claude case needs a raw-token file and without it all three cases skip");
	else if (!existsSync(tokenFile)) problems.push(`PI_CLAUDE_OAUTH_TOKEN_FILE points at ${tokenFile}, which does not exist`);

	const target = env.ACPX_MATRIX_FILE && env.ACPX_MATRIX_FILE.length > 0 ? env.ACPX_MATRIX_FILE : join(packageRoot, "test/acpx-real-matrix.test.ts");
	if (!existsSync(target)) problems.push(`matrix target ${target} does not exist`);

	const evidenceDir = env.MATRIX_EVIDENCE_DIR && env.MATRIX_EVIDENCE_DIR.length > 0 ? env.MATRIX_EVIDENCE_DIR : defaultEvidenceDir;
	return {
		dryRun: args.includes("--dry-run"),
		problems,
		target,
		evidenceDir,
		command: {
			executable: process.execPath,
			args: ["--experimental-strip-types", "--test", target],
			cwd: repoRoot,
			env: { RUN_REAL_ACPX_MATRIX: "1", MATRIX_EVIDENCE_DIR: evidenceDir },
		},
	};
}

function main() {
	const plan = matrixPlan(process.env);
	if (plan.problems.length > 0) {
		console.log("refusing to start: the real matrix is not configured.");
		for (const problem of plan.problems) console.log(`  - ${problem}`);
		console.log("  - RUN_REAL_ACPX_MATRIX is set by this script; the matrix cases skip unless it is 1, which is why a bare runner can report passes that never happened.");
		console.log("  - MATRIX_EVIDENCE_DIR defaults to agent-output/production-acpx-worker-backend/final-matrix; set it to keep evidence somewhere else.");
		console.log("Nothing ran, so nothing is proven. Run with --dry-run to print the command without starting a session.");
		return 1;
	}
	const { executable, args, cwd, env } = plan.command;
	if (plan.dryRun) {
		console.log(`would run: ${executable} ${args.join(" ")}`);
		console.log(`  cwd: ${cwd}`);
		console.log(`  env: RUN_REAL_ACPX_MATRIX=${env.RUN_REAL_ACPX_MATRIX} MATRIX_EVIDENCE_DIR=${env.MATRIX_EVIDENCE_DIR}`);
		console.log("dry run: no ACPX session was started and no provider credit was spent.");
		return 0;
	}
	console.log(`starting real ACPX sessions (pi, codex, claude) with RUN_REAL_ACPX_MATRIX=1; evidence goes to ${plan.evidenceDir}`);
	// Node marks its own test children with NODE_TEST_CONTEXT, and a nested `node --test` that inherits
	// it runs as a worker: it hides its output and exits 0 even when the tests inside it failed. The
	// variable is absent in a normal shell, so stripping it only matters when this script is itself run
	// from a test or CI step, which is exactly when a swallowed result would go unnoticed.
	const childEnv = { ...process.env };
	delete childEnv.NODE_TEST_CONTEXT;
	const run = spawnSync(executable, args, { cwd, env: { ...childEnv, ...env }, encoding: "utf8", shell: false, timeout: 900_000 });
	if (run.error) {
		console.log(`could not start the runner: ${run.error.message}`);
		return 1;
	}
	if (run.stdout) process.stdout.write(run.stdout);
	if (run.stderr) process.stderr.write(run.stderr);
	return run.status ?? 1;
}

// The exit code has to be assigned, not returned: a gate that always exits 0 cannot tell a refusal
// or a failed run from a passing one.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();