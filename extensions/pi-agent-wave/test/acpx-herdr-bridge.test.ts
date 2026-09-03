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

describe("ACPX-only Herdr bridge", () => {
	test("runs the ACPX worker through AgentFS, audits the report, exports owned changes, and cleans up", () => {
		const directory = mkdtempSync(join(tmpdir(), "acpx-herdr-bridge-"));
		directories.push(directory);
		const log = join(directory, "herdr.log");
		const envFile = join(directory, "tab.env");
		const cwdFile = join(directory, "tab.cwd");
		const tabState = join(directory, "tab.state");
		const herdr = join(directory, "herdr");
		writeFileSync(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1 $2" = "integration status" ]; then printf 'pi: current (v8) (/tmp/fake/herdr-agent-state.ts)\\n'; exit 0; fi
if [ "$1 $2" = "tab create" ]; then
  : > '${tabState}'
  : > '${envFile}'
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--cwd" ]; then shift; printf '%s\\n' "$1" > '${cwdFile}'; fi
    if [ "$1" = "--env" ]; then shift; key="\${1%%=*}"; value="\${1#*=}"; printf "export %s='%s'\\n" "$key" "$value" >> '${envFile}'; fi
    shift
  done
  printf '{"result":{"tab":{"tab_id":"workspace:tab"},"root_pane":{"pane_id":"workspace:pane"}}}\\n'; exit 0
fi
if [ "$1 $2" = "pane run" ]; then . '${envFile}'; cd "$(cat '${cwdFile}')"; "$4"; exit $?; fi
if [ "$1 $2" = "pane get" ]; then if [ -f '${tabState}' ]; then printf '{"result":{"pane":{"pane_id":"workspace:pane","tab_id":"workspace:tab"}}}\\n'; exit 0; else exit 1; fi; fi
if [ "$1 $2" = "tab list" ]; then if [ -f '${tabState}' ]; then printf '{"result":{"tabs":[{"tab_id":"workspace:tab"}]}}\\n'; else printf '{"result":{"tabs":[]}}\\n'; fi; exit 0; fi
if [ "$1 $2" = "tab close" ]; then rm -f '${tabState}'; printf '{"result":{"type":"ok"}}\\n'; exit 0; fi
if [ "$1 $2" = "agent get" ]; then exit 1; fi
printf '{"result":{"type":"ok"}}\\n'
`, { mode: 0o755 });
		chmodSync(herdr, 0o755);
		const fakeAcpx = join(process.cwd(), "extensions/pi-agent-wave/test/support/fake-acpx.mjs");
		writeFileSync(join(directory, "acpx"), readFileSync(fakeAcpx), { mode: 0o755 });
		chmodSync(join(directory, "acpx"), 0o755);
		const script = join(process.cwd(), "extensions/pi-agent-wave/scripts/herdr_delegate.py");
		const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "supervisor-tab" };
		const init = spawnSync("python3", [script, "init", "acpx bridge"], { encoding: "utf8", env });
		assert.equal(init.status, 0, init.stderr);
		const runDir = init.stdout.trim();
		const taskFile = join(runDir, "task.md");
		const report = join(runDir, "report.json");
		writeFileSync(taskFile, "Write a valid report.\n", { mode: 0o600 });
		writeFileSync(report, `${JSON.stringify({ schemaVersion: 1, verdict: "DONE", claims: [{ statement: "Fixture worker completed", evidence: [{ kind: "command", source: "fake-acpx", detail: "Structured end_turn" }], verification: "verified" }] }, null, 2)}\n`, { mode: 0o600 });
		const start = spawnSync("python3", [script, "start", runDir, "implementer", "coding", report, taskFile,
			"--policy", "auto", "--policy-digest", "a".repeat(64), "--chain", "openai-codex/gpt-5.6-sol", "--thinking", "high", "--session", "true", "--node", "implement",
			"--run-id", "run-bridge-1", "--operation-id", "operation-bridge-1", "--owned-paths-json", JSON.stringify(["extensions/pi-agent-wave/lib/acpx-types.ts"]), "--model-attempt", "0", "--transient-attempt", "0"],
			{ encoding: "utf8", env, timeout: 120_000 });
		assert.equal(start.status, 0, start.stderr);
		const result = JSON.parse(start.stdout);
		assert.equal(result["acp-agent"], "codex");
		assert.equal(result["acpx-session"], result["agentfs-session"]);
		const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
		const resource = state.resources.at(-1);
		assert.equal(resource.run_id, "run-bridge-1");
		assert.equal(resource.operation_id, "operation-bridge-1");
		assert.equal(resource.agentfs_db_path, result["agentfs-db"]);
		assert.deepEqual(resource.owned_paths, [join(process.cwd(), "extensions/pi-agent-wave/lib/acpx-types.ts")]);
		assert.equal(existsSync(resource.acpx_cancel_script), true);
		assert.match(readFileSync(resource.acpx_cancel_script, "utf8"), /acpx-cancel\.ts/);
		assert.equal(existsSync(resource.acpx_cancel_config), true);
		const cancelConfig = JSON.parse(readFileSync(resource.acpx_cancel_config, "utf8"));
		assert.deepEqual({ sessionName: cancelConfig.sessionName, recordId: cancelConfig.recordId, attemptKey: cancelConfig.attemptKey }, { sessionName: resource.acpx_session, recordId: resource.acpx_record_id, attemptKey: resource.acpx_attempt_key });
		const launcher = readFileSync(resource.worker_launcher, "utf8");
		assert.match(launcher, /agentfs.*run.*--no-default-allows/);
		assert.match(launcher, /acpx-worker\.ts/);
		assert.match(readFileSync(script, "utf8"), /main\("herdr"\)/);
		const transportSource = readFileSync(join(process.cwd(), "extensions/pi-agent-wave/scripts/delegate_core.py"), "utf8");
		assert.doesNotMatch(transportSource, /"--kind",\s*"pi"/);
		assert.match(transportSource, /"hostReadOnly": read_only/);
		assert.match(transportSource, /"discardAllChanges": read_only/);
		assert.match(transportSource, /cancel_attempt: Any = run_structured_cancel/);
		assert.doesNotMatch(transportSource, /run_acpx_again\(resource,\s*None,\s*"cancel"/);
		assert.doesNotMatch(readFileSync(join(process.cwd(), "extensions/pi-agent-wave/scripts/acpx-worker.ts"), "utf8"), /mode === "cancel"/);
		const invocations = readFileSync(log, "utf8");
		assert.ok(invocations.indexOf("tab create") < invocations.indexOf("pane report-agent"));
		assert.ok(invocations.indexOf("pane report-agent") < invocations.indexOf("pane run"));
		const wait = spawnSync("python3", [script, "wait", runDir, result.agent], { encoding: "utf8", env, timeout: 120_000 });
		assert.equal(wait.status, 0, wait.stderr);
		const audited = JSON.parse(wait.stdout);
		assert.equal(audited.report.verdict, "DONE");
		assert.equal(audited.acpxSession, result["acpx-session"]);
		assert.equal(audited.agentFsSession, result["agentfs-session"]);
		assert.equal(audited.agentFsExport.exported, true);
		assert.equal(audited.agentFsExport.violations.length, 0);
		assert.ok(audited.settlementEvidencePath);
		const settlement = JSON.parse(readFileSync(audited.settlementEvidencePath, "utf8"));
		assert.equal(settlement.runId, "run-bridge-1");
		assert.equal(settlement.operationId, "operation-bridge-1");
		assert.equal(settlement.ledgerValid, true);
		assert.equal(settlement.sessionClosed, true);
		assert.equal(settlement.providerLinksVerified, true);
		assert.equal(settlement.cleanupVerified, true);
		assert.ok(audited.cleanupEvidencePath);
		const cleanup = JSON.parse(readFileSync(audited.cleanupEvidencePath, "utf8"));
		assert.equal(cleanup.tabAbsent, true);
		assert.equal(cleanup.paneAbsent, true);
		assert.equal(cleanup.agentAbsent, true);
		assert.equal(cleanup.ownedProcessesAbsent, true);
		assert.equal(existsSync(resource.attempt_dir), false);
		assert.match(readFileSync(log, "utf8"), /tab close workspace:tab/);
		rmSync(runDir, { recursive: true, force: true });
	});
});
