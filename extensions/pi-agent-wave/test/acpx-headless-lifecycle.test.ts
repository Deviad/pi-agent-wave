import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAcpxNdjson, reconcileAcpxLifecycle, runDirectCommand } from "./support/acpx-spike.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "support", "acpx-fixture.mjs");
const VISIBLE_RUNNER = join(HERE, "support", "acpx-visible-runner.sh");

function runFixture(mode: string) {
	const home = mkdtempSync(join(tmpdir(), "acpx-lifecycle-"));
	try {
		return runDirectCommand({
			executable: process.execPath,
			args: [FIXTURE, mode, "session-lifecycle"],
			cwd: home,
			env: { ...process.env, HOME: home, ACPX_SPIKE_MARKER: "assigned-before-launch" },
			timeoutMs: 5_000,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe("ACPX headless lifecycle", () => {
	test("rehearses direct argv, environment timing, stream separation, NDJSON, and exit propagation", () => {
		const result = runFixture("complete");
		const events = parseAcpxNdjson(result.stdout);
		assert.equal(result.exitCode, 0);
		assert.match(result.stderr, /fixture-stderr:assigned-before-launch/);
		assert.doesNotMatch(result.stdout, /fixture-stderr/);
		assert.deepEqual(events.map((event) => event.kind), ["started", "progress", "completed"]);
	});

	test("rehearses the persisted visible runner with separated files and exact exit propagation", () => {
		const directory = mkdtempSync(join(tmpdir(), "acpx-visible-runner-"));
		try {
			const stdoutPath = join(directory, "stdout.ndjson");
			const stderrPath = join(directory, "stderr.txt");
			const result = runDirectCommand({
				executable: "/bin/bash",
				args: [VISIBLE_RUNNER, process.execPath, stdoutPath, stderrPath, "--", FIXTURE, "crash", "runner-session"],
				cwd: directory,
				env: { ...process.env, ACPX_SPIKE_MARKER: "visible-runner" },
				timeoutMs: 5_000,
			});
			assert.equal(result.exitCode, 17);
			assert.equal(readFileSync(stdoutPath, "utf8"), result.stdout);
			assert.equal(readFileSync(stderrPath, "utf8"), result.stderr);
			assert.match(result.stderr, /fixture-stderr:visible-runner/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("reconciles non-waiting submission, reconnect, cancellation, crash, and cleanup independently", () => {
		const noWait = runFixture("no-wait");
		assert.equal(reconcileAcpxLifecycle({ events: parseAcpxNdjson(noWait.stdout), exitCode: noWait.exitCode, sessionState: "running", herdrVisible: true, reportValidated: false, evidenceAuditValid: false }).status, "running");

		const reconnect = runFixture("reconnect");
		assert.equal(reconcileAcpxLifecycle({ events: parseAcpxNdjson(reconnect.stdout), exitCode: reconnect.exitCode, sessionState: "idle", herdrVisible: true, reportValidated: true, evidenceAuditValid: true }).status, "completed");

		const cancelled = runFixture("cancel");
		assert.equal(reconcileAcpxLifecycle({ events: parseAcpxNdjson(cancelled.stdout), exitCode: cancelled.exitCode, sessionState: "idle", herdrVisible: true, reportValidated: false, evidenceAuditValid: false }).status, "cancelled");

		const crashed = runFixture("crash");
		const crashedState = reconcileAcpxLifecycle({ events: parseAcpxNdjson(crashed.stdout), exitCode: crashed.exitCode, sessionState: "dead", herdrVisible: false, reportValidated: false, evidenceAuditValid: false });
		assert.equal(crashed.exitCode, 17);
		assert.equal(crashedState.status, "failed");
		assert.ok(crashedState.blockers.includes("ACPX process exited with status 17"));
	});
});
