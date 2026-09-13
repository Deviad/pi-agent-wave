import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerConfig, runAcpxWorker } from "../scripts/acpx-worker.ts";

const probe = new URL("./support/runtime-result-probe.py", import.meta.url).pathname;
test("live result probe defaults to a dry plan without creating evidence or accessing providers", () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-probe-gate-"));
	try {
		const evidence = join(root, "evidence");
		const run = spawnSync("python3", [probe, "--evidence-dir", evidence], { encoding: "utf8", env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "absent"), PI_CLAUDE_OAUTH_TOKEN_FILE: join(root, "absent-token") } });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(JSON.parse(run.stdout).mode, "dry-run");
		assert.equal(JSON.parse(run.stdout).totalPrompts, 6);
		assert.equal(existsSync(evidence), false);
		const wrong = spawnSync("python3", [probe, "--codex-model", "other/model"], { encoding: "utf8" });
		assert.notEqual(wrong.status, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the runtime worker branch needs an attempt key and fails closed without a real acpx executable", async () => {
	const root = mkdtempSync(join(tmpdir(), "runtime-worker-gate-"));
	try {
		const value = { schemaVersion: 1, resultContract: "runtime-v1", attemptKey: "attempt", acpxExecutable: join(root, "must-not-execute"), agent: "codex", selectedModel: "openai-codex/gpt-6-astra", sessionName: "session", workspaceRelative: ".", node: "search", reportPath: join(root, "unused-report"), acpxHome: root, promptFile: join(root, "prompt"), resultPath: join(root, "result"), stdoutPath: join(root, "stdout"), stderrPath: join(root, "stderr"), timeoutSeconds: 1, hostReadOnly: true, discardAllChanges: true, noTerminal: true };
		assert.throws(() => parseWorkerConfig({ ...value, attemptKey: undefined }), /requires attemptKey/);
		writeFileSync(value.promptFile, "prompt", { mode: 0o600 });
		await assert.rejects(runAcpxWorker(parseWorkerConfig(value)), /ENOENT|ACPX session ensure failed/);
		assert.equal(existsSync(value.resultPath), false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
