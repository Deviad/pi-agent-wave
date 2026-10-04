import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerConfig, runAcpxWorker } from "../scripts/acpx-worker.ts";
import { parseRuntimeSettleConfig, settleRuntimeWorker } from "../scripts/runtime-settle.ts";
import { classifyFailure } from "../retry.ts";

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
