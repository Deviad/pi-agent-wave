import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ACPX-only headless transport", () => {
	test("headless and Herdr wrappers share one lifecycle implementation", () => {
		const scripts = join(process.cwd(), "extensions/pi-agent-wave/scripts");
		const core = readFileSync(join(scripts, "delegate_core.py"), "utf8");
		for (const [name, transport] of [["headless_delegate.py", "headless"], ["herdr_delegate.py", "herdr"]] as const) {
			const wrapper = readFileSync(join(scripts, name), "utf8");
			assert.match(wrapper, /from delegate_core import (?:main|\*)/);
			assert.match(wrapper, new RegExp(`main\\("${transport}"\\)`));
			for (const mechanism of ["prepare_acpx_attempt", "run_structured_cancel", "export_agentfs_owned_changes", "write_settlement_evidence", "cleanup_absence_inventory"]) assert.equal(wrapper.includes(`def ${mechanism}`), false);
		}
		for (const mechanism of ["prepare_acpx_attempt", "run_structured_cancel", "export_agentfs_owned_changes", "write_settlement_evidence", "cleanup_absence_inventory"]) assert.match(core, new RegExp(`def ${mechanism}`));
	});

	test("runs, settles, exports, and cleans up without Herdr", () => {
		const directory = mkdtempSync(join(tmpdir(), "acpx-headless-transport-"));
		directories.push(directory);
		const herdrLog = join(directory, "herdr.log");
		const fakeAcpx = join(process.cwd(), "extensions/pi-agent-wave/test/support/fake-acpx.mjs");
		writeFileSync(join(directory, "acpx"), readFileSync(fakeAcpx), { mode: 0o755 });
		chmodSync(join(directory, "acpx"), 0o755);
		writeFileSync(join(directory, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${herdrLog}'\nexit 91\n`, { mode: 0o755 });
		chmodSync(join(directory, "herdr"), 0o755);
		const script = join(process.cwd(), "extensions/pi-agent-wave/scripts/headless_delegate.py");
		const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
		delete env.HERDR_ENV;
		delete env.HERDR_WORKSPACE_ID;
		delete env.HERDR_TAB_ID;
		const init = spawnSync("python3", [script, "init", "headless bridge"], { encoding: "utf8", env });
		assert.equal(init.status, 0, init.stderr);
		const runDir = init.stdout.trim();
		const taskFile = join(runDir, "task.md");
		const report = join(runDir, "report.json");
		writeFileSync(taskFile, "Write a valid report.\n", { mode: 0o600 });
		writeFileSync(report, `${JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: [{ statement: "Fixture worker completed", evidence: [{ kind: "command", source: "fake-acpx", detail: "Structured end_turn" }], verification: "verified" }] }, null, 2)}\n`, { mode: 0o600 });
		const start = spawnSync("python3", [script, "start", runDir, "implementer", "coding", report, taskFile,
			"--policy", "auto", "--policy-digest", "a".repeat(64), "--chain", "openai-codex/gpt-5.6-sol", "--thinking", "high", "--session", "true", "--node", "implement",
			"--run-id", "run-1", "--operation-id", "operation-1", "--owned-paths-json", JSON.stringify(["extensions/pi-agent-wave/lib/acpx-types.ts"]), "--model-attempt", "0", "--transient-attempt", "0"],
			{ encoding: "utf8", env, timeout: 120_000 });
		assert.equal(start.status, 0, start.stderr);
		const result = JSON.parse(start.stdout);
		assert.equal(result.transport, "headless");
		assert.equal(result.tab, null);
		assert.equal(result.pane, null);
		const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
		const resource = state.resources.at(-1);
		assert.equal(resource.transport, "headless");
		assert.deepEqual(resource.attempt_identity.presentation, { kind: "headless" });
		assert.equal(resource.attempt_identity.herdrAgent, null);
		assert.ok(Number.isInteger(resource.worker_pid));
		const wait = spawnSync("python3", [script, "wait", runDir, result.agent], { encoding: "utf8", env, timeout: 120_000 });
		assert.equal(wait.status, 0, wait.stderr);
		const audited = JSON.parse(wait.stdout);
		assert.equal(audited.report.verdict, "DONE");
		assert.equal(audited.agentFsExport.violations.length, 0);
		const settlement = JSON.parse(readFileSync(audited.settlementEvidencePath, "utf8"));
		assert.equal(settlement.transport, "headless");
		assert.equal(settlement.presentationVerified, true);
		assert.equal("herdrAgent" in settlement, false);
		assert.equal("tabId" in settlement, false);
		assert.equal("herdrPaneId" in settlement, false);
		const cleanup = JSON.parse(readFileSync(audited.cleanupEvidencePath, "utf8"));
		for (const field of ["tabAbsent", "paneAbsent", "agentAbsent", "ownedProcessesAbsent", "sessionClosed"]) assert.equal(cleanup[field], true, field);
		assert.equal(existsSync(resource.attempt_dir), false);
		assert.equal(existsSync(herdrLog), false);
		rmSync(runDir, { recursive: true, force: true });
	});
});
