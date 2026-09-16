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

const measure = new URL("./support/runtime-measure.ts", import.meta.url).pathname;
test("the live drivers keep run state off an inherited TMPDIR and refuse a root that has already vanished", () => {
	// The 2026-09-16 live run put its database under a per-call TMPDIR that was reclaimed mid-run, discarding a
	// worker that had succeeded. A driver must never place run state there, and must refuse rather than spend a turn.
	const root = mkdtempSync(join(tmpdir(), "runtime-driver-root-"));
	try {
		const volatile = mkdtempSync(join(root, "volatile-"));
		const env = { ...process.env, TMPDIR: volatile, HOME: root, PI_CODING_AGENT_DIR: join(root, "absent"), PI_CLAUDE_OAUTH_TOKEN_FILE: join(root, "absent-token") };
		// Plans name a run root that is not the volatile TMPDIR.
		const probePlan = spawnSync("python3", [probe, "--dry-run", "--evidence-dir", join(root, "e1")], { encoding: "utf8", env });
		assert.equal(probePlan.status, 0, probePlan.stderr);
		const probeRoot = String(JSON.parse(probePlan.stdout).runRoot);
		assert.ok(!probeRoot.startsWith(volatile), `probe run root must not be under TMPDIR: ${probeRoot}`);
		const measurePlan = spawnSync(process.execPath, ["--experimental-strip-types", measure, "--dry-run", "--evidence-dir", join(root, "e2")], { encoding: "utf8", env });
		assert.equal(measurePlan.status, 0, measurePlan.stderr);
		const measureJson = measurePlan.stdout.slice(measurePlan.stdout.indexOf("{"), measurePlan.stdout.lastIndexOf("}") + 1);
		const measureRoot = String(JSON.parse(measureJson).runRoot);
		assert.ok(!measureRoot.startsWith(volatile), `measure run root must not be under TMPDIR: ${measureRoot}`);
		// A root that no longer exists is refused before any worker could start.
		const gone = mkdtempSync(join(root, "gone-")); rmSync(gone, { recursive: true, force: true });
		const probeRefused = spawnSync("python3", [probe, "--execute", "--agents", "pi", "--run-root", gone, "--evidence-dir", join(root, "e3")], { encoding: "utf8", env });
		assert.notEqual(probeRefused.status, 0, "the probe must refuse a vanished run root");
		assert.match(probeRefused.stdout + probeRefused.stderr, /refusing to start/);
		assert.equal(existsSync(join(root, "e3")), false, "no evidence directory is created for a refused run");
		const measureRefused = spawnSync(process.execPath, ["--experimental-strip-types", measure, "--execute", "--run-root", gone, "--evidence-dir", join(root, "e4")], { encoding: "utf8", env });
		assert.notEqual(measureRefused.status, 0, "the measurement driver must refuse a vanished run root");
		assert.match(measureRefused.stderr, /refusing to start/);
		assert.equal(existsSync(join(root, "e4")), false, "no evidence directory is created for a refused run");
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
