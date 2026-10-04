import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerConfig, runAcpxWorker } from "../scripts/acpx-worker.ts";
import { parseRuntimeSettleConfig, settleRuntimeWorker } from "../scripts/runtime-settle.ts";
import { classifyFailure } from "../retry.ts";
import { startupFailureEvidenceDirectory } from "../store.ts";
import { packageRoot } from "./support/repoRoot.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The live output of run_d0caa7e3 on 2026-10-04, as ACPX printed it for a failed `sessions ensure`. */
const ENSURE_FAILURE = '{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error: Cannot call write after a stream was destroyed","data":{"acpxCode":"RUNTIME","origin":"cli","sessionId":"unknown"}}}';

test("a worker whose ACPX session cannot be opened writes a failed result that settles and retries", async () => {
	const root = mkdtempSync(join(tmpdir(), "worker-startup-failure-"));
	roots.push(root);
	const attempt = join(root, "attempt");
	mkdirSync(attempt, { mode: 0o700 });
	const acpx = join(root, "acpx");
	writeFileSync(acpx, `#!/bin/sh\nprintf '%s\\n' '${ENSURE_FAILURE}' >&2\nexit 1\n`, { mode: 0o700 });
	const config = parseWorkerConfig({
		schemaVersion: 1, resultContract: "runtime-v1", attemptKey: "run:op:thinker:0:0:model:pi", acpxExecutable: acpx, agent: "pi",
		selectedModel: "alibaba/deepseek-v4.1-flash", sessionName: "dg-thinker-0-0-fixture", workspaceRelative: ".", node: "thinker_plan",
		acpxHome: join(root, "acpx-home"), promptFile: join(attempt, "prompt.md"), resultPath: join(attempt, "worker-result.json"),
		stdoutPath: join(attempt, "worker.stdout.ndjson"), stderrPath: join(attempt, "worker.stderr.txt"), timeoutSeconds: 5,
		hostReadOnly: true, discardAllChanges: true, noTerminal: false,
	});
	writeFileSync(config.promptFile, "prompt", { mode: 0o600 });

	const exitCode = await runAcpxWorker(config);
	assert.notEqual(exitCode, 0, "the worker still exits non-zero");
	assert.ok(existsSync(config.resultPath), "a result is written although no prompt ran");
	const result = JSON.parse(readFileSync(config.resultPath, "utf8"));
	assert.equal(result.schemaVersion, 2);
	assert.equal(result.resultContract, "runtime-v1");
	assert.equal(result.attemptKey, config.attemptKey);
	assert.equal(result.output.outcome.kind, "failed");
	assert.match(result.output.outcome.error, /^ACPX session ensure failed after 2 attempt\(s\): .*Cannot call write after a stream was destroyed/);
	assert.match(readFileSync(join(result.outputDir, "worker.stderr.txt"), "utf8"), /Cannot call write after a stream was destroyed/);

	const graphHome = join(root, "graph");
	mkdirSync(graphHome, { mode: 0o700 });
	const evidence = settleRuntimeWorker(parseRuntimeSettleConfig({
		schemaVersion: 1, attemptKey: config.attemptKey, workerResultPath: config.resultPath, kind: "research", baseDir: root, baseRevision: "none",
		checkpointPath: null, ownedPaths: [], readOnly: true, snapshotPath: null, agentFsExecutable: "agentfs",
		evidencePath: join(attempt, "runtime-settlement.json"), dbPath: join(graphHome, "graph.db"),
	}));
	assert.equal(evidence.outcome.kind, "failed");
	assert.equal(evidence.candidate, null);
	assert.equal(evidence.outcome.kind === "failed" ? classifyFailure(evidence.outcome.error).kind : "", "transient");
});

/** What `test/support/startup-failure-driver.py` reports after settling and cleaning one failed start. */
interface StartupFailureReport {
	readonly root: string;
	readonly graphHome: string;
	readonly runId: string;
	readonly operationId: string;
	readonly transientAttempt: number;
	readonly model: string;
	readonly settlementError: string | null;
	readonly bundleSelectedModel: string | null;
	readonly bundleStderrTail: string;
	readonly bundleStartupFailureEvidence: string | null;
	readonly evidenceFiles: readonly string[];
	readonly evidenceDirMode: string | null;
	readonly evidenceStderr: string | null;
	readonly evidenceEnvironment: { readonly cwd: string; readonly cwdLength: number; readonly acpxHomeLength: number; readonly environment: Record<string, string | null> } | null;
	readonly evidenceVersions: Record<string, unknown> | null;
	readonly retainsCredentialValue: boolean;
	readonly retainsSecretEnvironmentValue: boolean;
	readonly attemptDirectoryExists: boolean;
	readonly acpxHomeExists: boolean;
	readonly cleanupAttemptDirectoryAbsent: boolean | null;
	readonly cleanupAcpxSessionFilesAbsent: boolean | null;
}

test("a failed start's bundle carries the ensure stderr, and its evidence survives settlement and cleanup", () => {
	const run = spawnSync("python3", [join(packageRoot, "test/support/startup-failure-driver.py")], { encoding: "utf8", timeout: 180_000 });
	assert.equal(run.status, 0, run.stderr);
	const report = JSON.parse(run.stdout) as StartupFailureReport;
	roots.push(report.root);
	assert.equal(report.settlementError, null, `settlement must not fail: ${report.settlementError}`);

	// The bundle reads the stderr the failed ensure actually wrote, and names the frozen model.
	assert.match(report.bundleStderrTail, /Cannot call write after a stream was destroyed/);
	assert.equal(report.bundleSelectedModel, report.model);

	// The evidence directory is where the store will look for it, and outlives the attempt.
	const expected = startupFailureEvidenceDirectory(report.graphHome, report.runId, report.operationId, report.transientAttempt, report.model);
	assert.equal(report.bundleStartupFailureEvidence, expected);
	assert.ok(existsSync(expected), "the evidence directory survives cleanup");
	assert.equal(report.evidenceDirMode, "0o700");
	assert.equal(report.attemptDirectoryExists, false);
	assert.equal(report.acpxHomeExists, false);
	assert.equal(report.cleanupAttemptDirectoryAbsent, true, "cleanup still removes the attempt directory");
	assert.equal(report.cleanupAcpxSessionFilesAbsent, true, "cleanup still removes the ACPX home");
	for (const file of ["worker.stderr.txt", "environment.json", "worker-config.json", "versions.json", "_logs/2026-10-04T10_38_23_000Z-debug-0.log", "acpx-state/sessions/index.json"]) {
		assert.ok(report.evidenceFiles.includes(file), `the evidence holds ${file}: ${report.evidenceFiles.join(", ")}`);
	}
	assert.match(report.evidenceStderr ?? "", /Cannot call write after a stream was destroyed/);

	// Credentials never enter it: no credential file by name, no credential or secret-shaped value by content.
	assert.equal(report.evidenceFiles.some((file) => /(^|\/)(auth\.json|\.credentials\.json|setup-token|\.claude\.json)$/.test(file)), false);
	assert.equal(report.retainsCredentialValue, false, "the materialized provider credential is not copied");
	assert.equal(report.retainsSecretEnvironmentValue, false, "a secret-shaped environment value is reduced to its name");
	const environment = report.evidenceEnvironment;
	assert.ok(environment, "the redacted launch environment is retained");
	assert.equal(environment.environment.PI_DRIVER_FIXTURE_SECRET_TOKEN, null, "the name is kept, the value is not");
	assert.equal(typeof environment.environment.PATH, "string");
	assert.equal(environment.cwdLength, environment.cwd.length);
	assert.ok(environment.acpxHomeLength > 0);
	assert.ok(report.evidenceVersions && ["agentfs", "acpx", "pi", "node", "piAcp"].every((key) => key in report.evidenceVersions!), "versions are recorded");
});
