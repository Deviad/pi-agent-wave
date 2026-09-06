import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DRIVER = join(process.cwd(), "extensions/pi-agent-wave/test/support/acpx-cleanup-driver.py");

function driver(mode: "abort" | "default-cancel" | "persistence" | "inventory", name: string): Record<string, unknown> {
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

	test("cleanup is idempotent for an owned empty run", () => {
		const script = join(process.cwd(), "extensions/pi-agent-wave/scripts/herdr_delegate.py");
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
