import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Resolved from this file, not the working directory: the same suite must fail the same way whether
// it is started from the repository root or the package directory.
const DRIVER = new URL("./support/acpx-cleanup-driver.py", import.meta.url).pathname;

function driver(mode: "abort" | "default-cancel" | "persistence" | "inventory" | "teardown" | "closure" | "live", name: string): Record<string, unknown> {
	const result = spawnSync("python3", [DRIVER, mode, name], { cwd: process.cwd(), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

describe("ACPX AgentFS targeted cleanup", () => {
	for (const [name, mode] of [
		["cancel failure", "cancel"],
		["close failure", "close"],
		["provider-link removal failure", "provider-link"],
		["Herdr agent release failure", "herdr-agent-release"],
		["Herdr tab release failure", "herdr-tab-release"],
		["attempt-directory removal failure", "attempt-directory"],
	] as const) {
		test(`fails closed on ${name}`, () => assert.equal(driver("abort", mode).failed, true));
	}

	test("names a remaining credential by basename only", () => {
		const result = driver("abort", "provider-link");
		assert.equal(result.credentialPathLeaked, false, JSON.stringify(result.failures));
	});

	test("repeated teardown over a torn-down attempt converges with written absence evidence", () => {
		const result = driver("teardown", "repeat-teardown");
		if (result.skipped === true) return console.log(`skipped: ${String(result.reason)}`);
		assert.deepEqual(result.exits, [0, 0, 0], `repeat cleanup must converge: ${JSON.stringify(result)}`);
		assert.deepEqual(result.evidenceCounts, [1, 1, 1], "every cleanup pass must record its own absence audit");
		assert.deepEqual(result.closure, ["files-and-processes-absent"], "closure must come from an observation, never a literal");
		assert.deepEqual(result.missingNoise, [false, false, false], "an already-absent resource must not surface as a cancel or credential error");
		assert.equal(result.targetPathLeaked, false, "a credential target path must never reach the emitted reason");
		assert.equal(result.attemptRemained, false);
	});

	test("partial teardown of a missing launcher and credential converges on evidence", () => {
		const result = driver("teardown", "partial-teardown");
		if (result.skipped === true) return console.log(`skipped: ${String(result.reason)}`);
		assert.deepEqual(result.exits, [0, 0, 0], `a torn-down launcher and credential must not fail cleanup forever: ${JSON.stringify(result)}`);
		assert.deepEqual(result.missingNoise, [false, false, false], "the emitted reason must not name an absent launcher or credential");
		assert.deepEqual(result.evidenceCounts, [1, 1, 1]);
		assert.equal(result.attemptRemained, false);
	});

	test("teardown keeps failing closed while an owned credential link survives", () => {
		const result = driver("teardown", "survivor");
		if (result.skipped === true) return console.log(`skipped: ${String(result.reason)}`);
		assert.deepEqual(result.exits, [1, 1, 1], `a surviving provider link must never look like convergence: ${JSON.stringify(result)}`);
		assert.deepEqual(result.evidenceCounts, [0, 0, 0], "an incomplete teardown writes no absence evidence");
		assert.equal(result.linkRemained, true, "the surviving link must still be there for the next pass to find");
		assert.equal(result.targetPathLeaked, false, JSON.stringify(result));
	});

	// The process-survivor branch used to be proven only with injected `ps` text, so it could pass
	// while the real probe matched nothing. This case spawns an actual long-lived child carrying a
	// per-run unique session token, fails cleanup closed against it, then kills it and re-runs.
	test("fails closed against a real running owned process and converges after it is killed", () => {
		const result = driver("live", "live-process");
		if (result.skipped === true) return console.log(`skipped: ${String(result.reason)}`);
		const phaseOne = result.phaseOne as Record<string, unknown>;
		const phaseTwo = result.phaseTwo as Record<string, unknown>;
		assert.ok(Number(result.visibleBefore) >= 1, "the probe must see the spawned process in real ps output before cleanup runs");
		assert.equal(phaseOne.evidence, 0, "a live owned process must never produce absence evidence");
		assert.equal(phaseOne.exit, 1, "cleanup must fail closed while an owned process survives");
		assert.match(String(phaseOne.output), /ownedProcessesAbsent/, JSON.stringify(phaseOne));
		assert.equal(result.childAliveAtPhaseTwo, false);
		assert.equal(result.psAfterKill, 0, "the driver must leave no owned process behind");
		assert.equal(phaseTwo.exit, 0, `teardown must converge once the process is gone: ${JSON.stringify(phaseTwo)}`);
		assert.equal(phaseTwo.evidence, 1, "the converging pass must write its absence evidence");
		assert.equal(phaseTwo.closure, "files-and-processes-absent", "closure requires the process check to have really run");
	});

	test("reports a session as unclosed when a session file survives and nothing proved closure", () => {
		const result = driver("closure", "unobserved");
		assert.equal(result.failed, true, "a surviving session file must fail the absence audit");
		assert.match(String(result.reason), /sessionClosed/, "the audit must name the unclosed session instead of asserting closure");
		assert.equal(result.evidenceWritten, false, "an unproven closure writes no absence evidence");
	});

	test("records which observation proved session closure", () => {
		const result = driver("closure", "observed");
		assert.equal(result.failed, false);
		assert.equal(result.sessionClosed, true);
		assert.equal(result.closure, "close-proved", "closure must name the observation, not just a boolean");
	});

	test("executes the production default structured cancellation launcher", () => {
		assert.equal(driver("default-cancel", "default-cancel").passed, true);
	});

	test("writes no diagnostic bundle for an attempt that already settled", () => {
		const result = driver("absent-attempt", "absent-attempt");
		assert.deepEqual(result.bundles, [], "a settled attempt has no attempt directory, so cleanup must not fabricate diagnostics");
	});

	test("retains a bounded redacted diagnostic bundle when an attempt aborts", () => {
		const result = driver("diagnostics", "diagnostics");
		assert.equal(result.bundleCount, 1, "exactly one failure bundle per aborted attempt");
		assert.equal(result.bundleName, "failure-op-diagnostic.json");
		assert.equal(result.mode, "0o600");
		assert.equal(result.attemptRemoved, true, "the bundle must survive attempt-directory cleanup");
		assert.equal(result.terminalKind, "failed");
		assert.equal(result.processExitCode, 1);
		assert.equal(result.selectedModel, "alibaba/some-model");
		assert.equal(result.operationId, "op-diagnostic");
		assert.equal(result.leakedSetupToken, false);
		assert.equal(result.leakedBearer, false);
		assert.equal(result.leakedApiKeyAssignment, false);
		assert.equal(result.leakedBareProviderKey, false, "a bare sk- provider key must be redacted from retained diagnostics");
		assert.equal(result.leakedAccountEmail, false, "account email must not be retained in diagnostics");
		assert.equal(result.leakedAccountId, false, "account id must not be retained in diagnostics");
		assert.equal(result.eventsParseAsJson, true, "redaction must keep event entries parseable");
		assert.equal(result.redactionMarkerSeen, true);
		assert.equal(result.environmentPersisted, false, "worker environment must never be retained");
		assert.ok(Number(result.stderrTailBytes) <= 4096, `stderr tail exceeded the byte cap: ${String(result.stderrTailBytes)}`);
		assert.ok(Number(result.recentEventCount) <= 20, `event cap exceeded: ${String(result.recentEventCount)}`);
		assert.ok(Number(result.recentEventCount) >= 1);
	});

	test("fails closed on Herdr pane release by rejecting the remaining pane", () => {
		assert.ok((driver("inventory", "pane").falseFields as string[]).includes("paneAbsent"));
	});

	test("fails closed on cleanup-evidence persistence failure", () => {
		assert.equal(driver("persistence", "cleanup-evidence").failed, true);
	});

	for (const [resource, expectedField] of [
		["tab", "tabAbsent"],
		["pane", "paneAbsent"],
		["agent", "agentAbsent"],
		["queue-owner", "queueOwnerAbsent"],
		["acpx-session-files", "acpxSessionFilesAbsent"],
		["agentfs-mount", "agentFsMountAbsent"],
		["agentfs-server", "agentFsServerAbsent"],
		["agentfs-database", "agentFsDatabaseAbsent"],
		["agentfs-home", "agentFsHomeAbsent"],
		["provider-link", "providerLinksAbsent"],
		["report-repair-child", "reportRepairChildAbsent"],
		["attempt-directory", "attemptDirectoryAbsent"],
	] as const) {
		test(`rejects remaining ${resource}`, () => {
			const result = driver("inventory", resource);
			assert.ok((result.falseFields as string[]).includes(expectedField), JSON.stringify(result));
		});
	}

	test("supervisor lines never count as surviving owned processes", () => {
		const result = driver("inventory", "supervisor-noise");
		assert.deepEqual(result.ownedProcessMatches, [], JSON.stringify(result));
		assert.ok(!(result.falseFields as string[]).includes("ownedProcessesAbsent"), JSON.stringify(result));
	});

	for (const [resource, expectedPid] of [["session-worker", "204"], ["attempt-worker", "205"], ["launcher-worker", "202"], ["supervisor-named-argument", "206"]] as const) {
		test(`owned process ${resource} still fails closed beside supervisor noise`, () => {
			const result = driver("inventory", resource);
			assert.ok((result.falseFields as string[]).includes("ownedProcessesAbsent"), JSON.stringify(result));
			assert.deepEqual((result.ownedProcessMatches as string[]).map((line) => line.split(" ")[0]), [expectedPid], JSON.stringify(result));
		});
	}

	test("settlement waits for the worker process to exit after its result file appears", () => {
		const script = `
import json, os, subprocess, sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import delegate_core as core
core.ACTIVE_TRANSPORT = 'headless'
root = Path(sys.argv[2])
result_path = root / 'worker-result.json'
# A worker that writes its result and then lingers, like the AgentFS/acpx teardown does.
child = subprocess.Popen(['sh', '-c', 'printf \\'{"processExitCode":0,"terminal":{"kind":"completed"}}\\' > "$0"; sleep 0.6', str(result_path)])
resource = {'execution': 'acpx-agentfs', 'agent': 'fixture', 'worker_result': str(result_path), 'worker_pid': child.pid, 'report_repair_attempts': 0}
started = time.monotonic()
core.wait_for_settled_agent(root, resource)
settled = {'exited': resource['worker_exit']['exited'], 'pid': resource['worker_exit']['pid'] == child.pid, 'aliveAfter': core.process_alive(child.pid) and child.poll() is None,
           'waitedMs': resource['worker_exit']['waitedMs'], 'elapsedMs': int((time.monotonic() - started) * 1000), 'terminal': resource['worker_observation']['terminal']['kind']}
child.wait()
# A worker that never exits fails closed within the bounded timeout instead of being audited live.
lingering = subprocess.Popen(['sleep', '30'])
try:
    try:
        core.wait_for_worker_exit({'worker_pid': lingering.pid}, timeout_ms=300)
    except core.DelegateError as error:
        bounded = {'raised': True, 'message': str(error)}
    else:
        bounded = {'raised': False}
finally:
    lingering.kill(); lingering.wait()
# Herdr transport has no pid to wait for and records that instead of blocking.
core.ACTIVE_TRANSPORT = 'herdr'
herdr = core.wait_for_worker_exit({'worker_pid': None})
print(json.dumps({'settled': settled, 'bounded': bounded, 'herdr': herdr}))
`;
		const root = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
		try {
			const result = spawnSync("python3", ["-c", script, new URL("../scripts", import.meta.url).pathname, root], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
			assert.equal(result.status, 0, result.stderr);
			const { settled, bounded, herdr } = JSON.parse(result.stdout);
			assert.equal(settled.exited, true);
			assert.equal(settled.pid, true);
			assert.equal(settled.aliveAfter, false, "the audit must not start while the worker process is alive");
			assert.ok(settled.waitedMs >= 300, `the wait must actually cover the lingering process: ${JSON.stringify(settled)}`);
			assert.equal(settled.terminal, "completed");
			assert.equal(bounded.raised, true);
			assert.match(String(bounded.message), /did not exit within 300ms/);
			assert.deepEqual(herdr, { pid: null, exited: null, waitedMs: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("cleanup is idempotent for an owned empty run", () => {
		const script = new URL("../scripts/herdr_delegate.py", import.meta.url).pathname;
		const env = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID ?? "workspace", HERDR_TAB_ID: process.env.HERDR_TAB_ID ?? "tab" };
		const init = spawnSync("python3", [script, "init", "cleanup-idempotent"], { encoding: "utf8", env });
		assert.equal(init.status, 0, init.stderr);
		const runDir = init.stdout.trim();
		try {
			const first = spawnSync("python3", [script, "cleanup", runDir], { encoding: "utf8", env });
			const second = spawnSync("python3", [script, "cleanup", runDir], { encoding: "utf8", env });
			assert.equal(first.status, 0, first.stderr);
			assert.equal(second.status, 0, second.stderr);
		} finally {
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});
